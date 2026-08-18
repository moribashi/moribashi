# Architectural Decisions

## DI Container: Awilix with PROXY mode
- Awilix provides mature container with scoping, lifetime management, disposal
- PROXY injection mode: dependencies resolved lazily via Proxy object, supports circular detection
- `strict: true`: prevents lifetime leakage (singletons can't depend on shorter-lived services)

## Lifecycle: Duck-typed interfaces
- Services implement `onInit()`/`onDestroy()` methods — detected at runtime via typeof check
- No decorators, no metadata reflection — keeps it simple and compatible
- Interfaces (`OnInit`, `OnDestroy`) in `@moribashi/common` for type-safety, but runtime detection is structural
- Singletons: `onInit` called during `app.start()`, `onDestroy` during `app.stop()` in reverse order

## Plugin System: Deferred registration
- `app.use(plugin)` collects plugins; `app.start()` calls `register()` in order
- This allows all plugins to be collected before any run, enabling ordered initialization
- Plugins register into the one root container — no per-plugin containers
- `register()` can be async for plugins that need setup (loading config, etc.)

## Scopes: Symbol.for() keys
- Named scopes use `Symbol.for('moribashi.scope.<name>')` for cross-package compatibility
- `app.registerInScope(key, services)` stores scoped registrations
- `app.createScope(key)` creates Awilix child scope with stored registrations applied
- Framework tracks active scopes; `app.stop()` disposes all remaining scopes
- Scopes are opt-in — most plugins just register singletons into root

## TypeScript Config: Decentralized rootDir
- `tsconfig.base.json` does NOT set `rootDir` or `outDir` — each package sets its own
- Allows `examples/simple` to use `paths` mappings (for IDE click-through to package sources) without TS6059 errors
- Example uses `noEmit: true` so rootDir is irrelevant for its output

## Repository Pattern: Repo + RepoQuery with SQL files
- `RepoQuery<E>` wraps a single SQL query with typed, bounds-checked access (`one`, `any`, `many`, `none`)
- `Repo` base class auto-wires `RepoQuery` fields by reading `.sql` files from a `sql/` directory next to the repo
- SQL file names must match the `RepoQuery` property names (e.g. `findById` → `sql/findById.sql`)
- `_autowire()` must be called at the end of the **subclass** constructor, not in `super()` — JS class field initializers run after `super()` returns, so the `RepoQuery` fields don't exist during the base constructor
- Keeps SQL out of TypeScript — easier to read, lint, and review separately
- Uses `fs.readFileSync` at construction time (sync, one-time cost at startup)

## GraphQL Federation: opt-in flag now, default flips later
- `graphqlPlugin({ federated: true })` swaps the registered Mercurius plugin for `@mercuriusjs/federation`'s `mercuriusFederationPlugin` — same `schema`/`resolvers`/`graphiql` options, so it's a near-drop-in swap under the hood
- Default is `false` today; the plan (GH #4) is to flip it to `true` in a later release once there's been time to inventory existing consumers — flipping now would be a silent behavior change for anyone relying on the current plain-schema default
- Rationale for defaulting to federated *eventually*: an escape hatch that requires a consumer to already know federation exists (the old `bindResolvers`/`scopeContext` manual path) rarely gets used — the path of least resistance produces whatever `graphqlPlugin()` gives you with no extra config. See `docs/federation-first-design.md` for the full argument.
- SDL convention for federated mode: `extend type Query`/`extend type Mutation`, not `type Query`/`type Mutation` — federation subgraphs are still fully valid, independently-queryable schemas on their own; the only addition is a `_service { sdl }` introspection field the gateway needs

## Gateway: gatewayPlugin() is a first-class Moribashi app, not plain Fastify
- Composes subgraphs via `@mercuriusjs/gateway`; deliberately diverges from the plain-Fastify-plus-`@mercuriusjs/gateway` reference pattern this was modeled on (no framework involvement in that pattern) — the gateway gets DI/lifecycle/plugin-system just like any other Moribashi app
- Subgraphs default to `mandatory: false` — the gateway starts even if one isn't reachable yet, and `pollingInterval` (default 10s) picks it up later; `retryServicesCount`/`retryServicesInterval` (defaults 3/2000ms) retry per-subgraph reachability on each attempt
- Deliberately does NOT implement an outer whole-process retry loop for the "zero subgraphs reachable at cold boot" case (the reference implementation recreates its whole Fastify instance per retry attempt to work around this) — that pattern doesn't fit Moribashi's single-shared-Fastify-instance-in-the-DI-container model, and retrying `.ready()` on a Fastify instance whose boot already failed isn't safe. Boot failures propagate and the process exits; recovery is left to the process supervisor (e.g. Kubernetes restart). Documented as a deliberate tradeoff, not an oversight.
- `mercurius` dependency bumped `^15` → `^16` in `@moribashi/graphql` because `@mercuriusjs/federation`/`@mercuriusjs/gateway` (v5.x) require `mercurius@^16`; without the bump, pnpm installs two incompatible copies and TypeScript can't unify their option types

## Reference monorepo: examples/platform
- Demonstrates the recommended shape for a team's own platform: one pnpm monorepo containing the gateway + a handful of "core" subgraphs (here: `identity`, `catalog`) — each an ordinary Moribashi app in its own package under `examples/platform/`
- Added `examples/platform/*` to the root `pnpm-workspace.yaml` glob (previously only `examples/*`, which wouldn't pick up nested per-service packages)
- New team-owned subgraphs are meant to live in their own separate repos, not in this monorepo — see the "Adding a new team-owned subgraph" recipe in `docs/claude-instructions.md`. Deploy/discovery automation for that path is explicitly out of scope for `@moribashi/graphql` (tracked: GH #3)

## Auth: capture verification errors, never reject at the hook
- `authPlugin`'s `onRequest` hook always lets the request proceed: no header → anonymous; bad token → anonymous + a typed `AuthError` captured into the request scope
- The captured error surfaces when the app calls `ensureAuthenticated()`/`ensureAny()`, preserving the true cause (`SessionExpiredError` vs generic "not authenticated")
- Rationale: one GraphQL operation can touch public and protected fields — public fields must resolve while protected fields fail precisely
- Principal is a discriminated union: `AnonymousPrincipal` (sealed singleton, `===` across requests) | `TokenPrincipal` (immutable token facts only — no authorization state, loaders, or caches)

## Auth: contextual access via AccessLoader, not token claims
- Global permissions ride in the token's identity claim block; context-scoped roles/permissions are fetched through an app-registered `accessLoader` (DI name) behind a short-TTL cache (default 60s) keyed `identity:contextId`
- Rationale: contextual access changes without re-login and bloats tokens
- Global vs contextual checks are separate methods (`hasGlobal` vs `withContext(...).hasAny`) — no overloads dispatching on argument type
- No `accessLoader` registered → `withContext()` throws a configuration error at call time; token-only methods work standalone

## Auth: multi-issuer trust is declarative; k8s is just another issuer
- Each `issuers[]` entry: OIDC discovery root (must equal `iss` exactly), audience, app-assigned `tid`; unlisted issuers are invalid tokens
- Static `jwks` on an issuer entry enables fully-offline verification (tests, air-gapped) — no separate test seam needed
- Identity facts come from a namespaced claim block (`claims: "app"`) or a mapper fn — the mapper covers issuers that don't mint the block (k8s SA tokens derive identity from `sub`)
- Outbound workload identity is a separate opt-in plugin (`workloadIdentityPlugin`) registering a `serviceToken` singleton: RFC 8693 exchange of the pod's projected SA token; the ServiceAccount is the credential, no deployed secrets

## Kafka: protobuf, not Avro
- The `.proto` is the source of TypeScript types at the service level (generated with Buf), so a producer physically cannot construct a payload that diverges from the registered schema — the type error lands at compile time, in the service, before anything is sent
- Avro's `.avsc` gives no such guarantee: the payload is a plain object checked at encode time, so a schema/payload divergence is a runtime failure on a live send
- Cost accepted deliberately: the `.proto` is parsed twice — by protobufjs for wire encoding inside `@kafkajs/confluent-schema-registry`, and by Buf for TS type generation at the service level. Redundant, and worth it
- `@bufbuild/protobuf` stays a **service-level** dependency. `@moribashi/kafka` does not depend on it — a framework package's weight is inherited by every service that installs it

## Kafka client: @platformatic/kafka, not kafkajs
- Pure JS with no native bindings. Services build on `node:24-alpine`; native addons are a musl compatibility risk that shows up at deploy time, not at build time
- TypeScript-native and actively maintained. `kafkajs` was rejected outright: last published February 2023
- Consequence for the package shape: `@platformatic/kafka` has no central `Kafka` object like kafkajs — `Producer`/`Consumer`/`Admin` each take their own connection options. So `KafkaClient` here is a plain `{ config, connectionOptions, registry }` value object rather than a wrapper around a vendor client
- Its `SASLOptions.token` accepts a `CredentialProvider` (`() => string | Promise<string>`), called per authentication — which is exactly the contract a refresh-ahead token provider wants, and why no token is ever captured at construction

## Kafka wire format: @kafkajs/confluent-schema-registry, not @confluentinc/schemaregistry
- Both support `SchemaType.PROTOBUF`. The deciding factor is dependency weight: `@confluentinc/schemaregistry`'s `dependencies` include `@aws-sdk/client-kms`, `@azure/identity`, `@azure/keyvault-keys`, `@google-cloud/kms`, `node-vault`, `simple-oauth2`, and `jsonata` — client-side field-level encryption and data contracts, none of which we use. Every service would inherit all of it
- `@kafkajs/confluent-schema-registry` has **no kafkajs dependency** despite the name (ajv, avsc, mappersmith, protobufjs) — it is transport-agnostic, so pairing it with `@platformatic/kafka` is not a hack
- Confluent wire framing (magic byte + schema id + protobuf message-index varints) is deliberately **not hand-rolled**. It is fiddly, and the library is exactly the part worth taking a dependency for. The opt-in integration suite exists to prove that framing round-trips against a real registry

## Kafka schemas: declarative registration, not a migration ledger
- Registration has `SqlMigrationSource`'s *ergonomics* — a directory of files in the service repo, processed during plugin `register()` (which `app.start()` awaits before resolving singletons), throwing loudly so the pod crashloops and ArgoCD goes red
- It has **none of its machinery**: no version-prefixed filenames, no ordering, no local ledger, no `down`. Registration is declarative and idempotent — you post the schema you currently want for a subject, and the registry either returns the existing id unchanged or rejects the change as incompatible
- **The registry is the ledger.** That is the whole reason drift is impossible and no local state is needed. A local ledger would be a second source of truth that can disagree with the registry, which is precisely the failure mode migrations exist to prevent in SQL and that the registry already prevents here
- Subject naming is Confluent's `TopicNameStrategy` (`<topic>-value`), and the file is named after the subject. Registration derives the subject from the filename, the producer derives it from the topic; the two derivations meeting is what keeps them pointed at one subject
- **Registration is producer-scoped and opt-in** (`registerSchemas: true`), not symmetric. A consumer that registers a schema is a service asserting a contract it does not own
- `checkSchemaCompatibility()` is a separate exported function that runs the same check without registering and returns a report rather than throwing. Ravn's registry is in-cluster only today, so CI cannot reach it — the point is that failing a PR instead of a pod later needs no new code, only wiring

## Kafka ↔ auth: a token provider, not a package dependency
- SASL/OAUTHBEARER needs a bearer token; `@moribashi/auth` already ships `workloadIdentityPlugin`, which registers a `serviceToken` provider doing the RFC 8693 exchange with refresh-ahead-of-expiry
- A `kafka → auth` dependency would **invert the build order** (`common → core → {cli, graphql, kafka, pg, web} → auth`) and drag jose + web into every service that only wants to produce events
- Instead `kafkaPlugin` accepts `tokenProvider?: () => Promise<string>`, and the service wires the two: `tokenProvider: () => app.resolve<ServiceToken>('serviceToken').get()`. Neither package knows about the other, and the same seam works for any other token source
- Corollary: the mechanism comes from env (`KAFKA_SASL_MECHANISM`) but the token cannot, so `oauthbearer` without a `tokenProvider` is a config error naming `serviceToken` in its message
- hd-kafka's file-reading `token.ts` was deliberately not reimplemented — re-reading the projected SA token is `serviceToken`'s job, and it also handles the exchange and refresh that file-reading alone does not

## Kafka: deliberate divergences from the hd-kafka prior art
- **No `gracefulShutdown()` with process handlers.** hd-kafka registers its own SIGTERM/SIGINT and calls `process.exit(0)`, which fights `app.stop()` and the service's own signal handling. Disconnection is `producer.onDestroy()`, fired by core's lifecycle in reverse init order
- **Per-message keys.** hd-kafka applies one `sendOpts.key` to every message in a batch, which mis-partitions the moment a batch spans two entities. `ProducerMessage.key` is per message
- **Bounded schema-id cache.** hd-kafka caches `subject → schemaId` forever with no invalidation, so a registry update is never seen without a restart. Here it is a TTL (default 5 min, `0` disables) with in-flight coalescing and an explicit `clearSchemaCache(subject?)`
- **No config field for `allowAutoTopicCreation`** — env-only (`KAFKA_ALLOW_AUTO_TOPIC_CREATION`), defaulting to `false` to match the cluster. Carried over from hd-kafka and kept for the same reason: a topic appearing because a name was typo'd is silent data loss
- **No defaults for `clientId`/`brokers`/`schemaRegistry.url`.** hd-kafka defaults to `localhost`; a service that silently talks to localhost in production fails worse than one that crashloops
- **Config is validated at `kafkaPlugin()` construction**, not inside `register()`. Resolving config opens no connection, so there is no reason to defer the throw into a rejected `app.start()`

## Kafka: producer-only for 0.4.0
- The brief scoped the package to connection lifecycle, DI registration, schema registration and shutdown, and the first consumer (svc-iam) only produces. No `createConsumer()` ships in 0.4.0
- A consumer is not just the mirror of the producer — it needs the scope story (`EventContext`, already on the roadmap as a scope plugin), offset/commit semantics, and a decode-failure policy (DLQ vs crash). Shipping those unasked would be untested surface in a package other services depend on
- `@platformatic/kafka`'s `Consumer` is directly usable in the meantime with `kafkaClient.connectionOptions`, and `schemaRegistry.decode()` handles the wire format — which is exactly what the integration suite does
