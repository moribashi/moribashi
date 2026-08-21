# Progress

## Current Milestone
Event transport — `@moribashi/kafka` provides both halves of a Kafka/Redpanda transport as standard
plugins: a producer with protobuf schema registration at boot and per-message keying, and a consumer
with a per-message DI scope, at-least-once commits, bounded retry, and a configurable
throw/skip/DLQ failure policy. Slated for the 0.4.0 lockstep train.

## Recently Completed
- Switched `@moribashi/kafka` off `@kafkajs/confluent-schema-registry` and onto `@confluentinc/schemaregistry`, fixing a wire-format bug found in production on `iam.identity.created.v1`: the old library omitted the protobuf **message-index array**, so byte 5 was a protobuf field tag (`0x0a`) instead of the index array (`0x00`). It only broke *other* consumers — producer and consumer were symmetric, so the suite stayed green while Redpanda Console showed `UTF8WITHCONTROLCHARS`. `src/__tests__/wire-format.test.ts` now asserts the prefix byte for byte with no broker, and the integration suite reads the topic back in a **separate process** with a stock Confluent deserializer
- Wired Buf-generated `@bufbuild/protobuf` message types straight into the serializer (`messages: { [topic]: FooSchema }`), removing the second `.proto` parse the original design accepted as a cost. Boot-time registration is preserved deliberately: the serializer runs `autoRegisterSchemas: false` + `useLatestVersion: true`, so an incompatible contract still fails inside plugin `register()` rather than on the first produce
- Fixed a second silent-corruption bug the switch exposed: Redpanda's `?format=serialized` descriptors leave `type` unset on message- and enum-typed fields, and `@bufbuild/protobuf` links them as scalars — a nested message decoded as a NaN double. `src/descriptors.ts` repairs registry descriptors before they are linked, and throws rather than guessing when a type cannot be resolved
- Built `@moribashi/kafka` (new package, 0.4.0): `kafkaPlugin` registering `kafkaClient`/`schemaRegistry`/`producer` (producer a singleton so `app.stop()` disconnects it), a framework-free core (`createKafkaClient`/`createProducer`) mirroring `createKnex`, declarative `.proto` registration at boot with the registry as the ledger, a separable `checkSchemaCompatibility()` for a future CI gate, per-message partition keys, a TTL-bounded `subject → schemaId` cache, and SASL (SCRAM/PLAIN from env, OAUTHBEARER via an injected `tokenProvider` so there is no `kafka → auth` edge)
- Added the consumer to `@moribashi/kafka`: `kafkaConsumerPlugin` (a second opt-in plugin that reuses an already-registered `kafkaClient`), a per-message DI scope keyed `EVENT_SCOPE` mirroring `WEB_REQUEST_SCOPE`, at-least-once commit-after-handler with autocommit explicitly disabled, bounded in-process retry with exponential backoff, a `'throw' | 'skip' | { dlq }` failure policy covering decode failures and handler throws alike, DLQ routing that preserves the original bytes plus `x-moribashi-dlq-*` failure headers, per-partition sequential / cross-partition parallel processing bounded by `concurrency`, and handler binding by explicit map *and* `*.handler.ts` convention (explicit wins; a convention double-bind is a startup error)
- Settled the four questions the producer round deferred (scope, commit semantics, failure policy, handler binding) — recorded with rationale in decisions.md, including why `'throw'` had to be defined as *stop consuming* rather than propagate-and-retry, and why queued messages must be abandoned rather than committed once a fatal is in flight
- Test suite now 357: 347 unit (config, client, schemas, producer, handlers, consumer, plugin, barrel, adversarial) and 10 opt-in integration tests verified against a real single-node Redpanda — the Confluent protobuf wire round-trip, schema registration idempotency, an incompatible-change rejection, a full produce → consume → decode → commit round-trip with committed offsets checked through the Admin API, per-message scoped-service resolution, and a poison message reaching a real DLQ topic with its original bytes and failure headers intact
- Merged PR #14 (`@moribashi/auth`) after rebasing onto main: fixed a post-rebase type error against PR #9's typed `WebRequestCradle` by declaration-merging `AuthCradle` into it from `@moribashi/auth` (importing the package now types the auth services on `request.scope`); added auth+graphql type-checks and the auth test suite to CI
- Cut and tagged **0.3.0** (auth package + typed web Fastify surface) — all seven packages live on npm. `@moribashi/auth`'s first publish went through CI via an `NPM_TOKEN` secret fallback in publish.yml (trusted publishing/OIDC can't create a new package). Follow-up: configure a trusted publisher for `@moribashi/auth` on npmjs.com, then delete the `NPM_TOKEN` repo secret so all packages ride the tokenless OIDC path
- Implemented `@moribashi/auth` (GH #11): `authPlugin` (issuer selection by unverified `iss`, JWKS via static set / direct URI / OIDC discovery, jose-backed verification), `AnonymousPrincipal`/`TokenPrincipal` union, captured-error model (`AuthError` taxonomy — hook never 401s; errors surface from `ensure*` with true cause), `SecurityService` with `AccessLoader` + shared TTL `AccessCache`, and `workloadIdentityPlugin` (`serviceToken` singleton: RFC 8693 exchange of projected SA tokens, refresh-ahead-of-expiry, file re-read on rotation)
- 33 tests for auth: offline JWKS unit tests, cache TTL/isolation/failure tests, fake-token-endpoint workload-identity tests, and a full web+auth+graphql integration test (public + protected fields in one operation)
- Fixed TS6059 errors by removing redundant `rootDir`/`outDir` from `tsconfig.base.json` (packages set their own)
- Added lifecycle interfaces (`OnInit`, `OnDestroy`) to `@moribashi/common`
- Added plugin system (`MoribashiPlugin`, `app.use()`), composable scopes (`app.createScope(key?)`), and lifecycle management (`app.start()`/`app.stop()`) to `@moribashi/core`
- Named scopes via `Symbol.for()` — `app.registerInScope(key, services)` + `app.createScope(key)`
- Re-exported Awilix utilities (`asClass`, `asFunction`, `asValue`, `Lifetime`) from core
- Updated example with lifecycle hooks on `BooksService`
- IDE click-through works via `paths` mappings in `examples/simple/tsconfig.json`
- Implemented `RepoQuery<E>` with bounds-checked query methods (`one`, `any`, `many`, `none`) in `@moribashi/pg`
- Implemented `Repo` base class + `autowireRepo()` for convention-based SQL-file repositories
- Added unit tests (mocked Db) and integration tests (real Postgres + temp SQL files) for Repo/RepoQuery
- Updated README, claude-instructions, and CLAUDE.md with Repo pattern documentation
- Built `@moribashi/graphql` (Mercurius-based GraphQL plugin, resolvers `this`-bound to scope cradle) and shipped the namespaced-domain-pattern doc for large schemas
- Added `graphqlPlugin({ federated: true })` — registers via `@mercuriusjs/federation` instead of plain Mercurius; default stays `false` for now (rollout plan: opt-in flag now, flip default in a later release)
- Added `gatewayPlugin()` — composes federated subgraphs via `@mercuriusjs/gateway`, as a first-class Moribashi app (DI/lifecycle apply, unlike the plain-Fastify reference pattern this diverges from)
- Bumped `mercurius` dependency from `^15` to `^16` in `@moribashi/graphql` (required by `@mercuriusjs/federation`/`@mercuriusjs/gateway`; avoids a duplicate-mercurius-version type conflict)
- Added `examples/platform` — a runnable reference monorepo: gateway + two core subgraphs (`identity`, `catalog`), verified end-to-end (composed queries spanning both subgraphs work through the gateway)
- Documented the federated pattern as "Phase 3" in `docs/claude-instructions.md`, updated `docs/graphql-namespace-pattern.md`'s federation section to reference the `federated: true` flag, and added `@moribashi/graphql` to the README's package table (was missing)
- Wrote `docs/federation-first-design.md` — the design rationale for defaulting to federation
- Typed Fastify surface in `@moribashi/web`: `getFastify(app)` accessor, `WebCradle`/`WebRequestCradle` contracts, `request.scope` typed as `MoribashiScope<WebRequestCradle>`, and expanded Fastify type re-exports (hook handlers, plugin types, `RouteOptions`, etc.) so consumers never need `any` or manual `resolve<FastifyInstance>` generics

## Next Steps
- Decide the release version for the `@confluentinc/schemaregistry` switch — the public API broke (`SchemaRegistryClient.encode/decode` are topic-scoped, `ProducerMessage.value` is a generated message, `messages` is required for producers), so it is not a patch
- Auth follow-ups deferred by GH #11: session/cookie auth, opaque-token introspection (RFC 7662), impersonation semantics (claim shape reserves `audit` vs `identity`), GraphQL schema directives
- Flip `graphqlPlugin()`'s `federated` default to `true` in a future release (tracked: GH #4) — needs a consumer inventory first since it's a behavior change
- Gateway subgraph discovery/composition automation — currently a manual step (edit the gateway's `subgraphs` list); deliberately deferred, tracked separately (GH #3, noted in GH #5's scope too)
- Shared-entity (`@key` / `__resolveReference`) pattern is documented but unimplemented anywhere in this repo — design it once a real cross-subgraph entity need shows up, not speculatively
- `@moribashi/cli` remains an unimplemented stub — scaffolding tooling for new subgraphs/platforms was explicitly deferred, not in scope for this round
- Wire `checkSchemaCompatibility()` into CI once the Schema Registry is reachable from GitHub Actions (in-cluster only today), so an incompatible contract change fails a PR instead of a pod
- Build concrete scope plugins (WebContext via `@moribashi/web`) — the event scope now exists as `EVENT_SCOPE` in `@moribashi/kafka`
- Add scoped service lifecycle hooks (onInit/onDestroy within scopes)
- Middleware/interceptor support
- Migrate example app repos to use `Repo`/`RepoQuery` pattern
