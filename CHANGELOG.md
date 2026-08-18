# Changelog

All notable changes to the `@moribashi/*` packages are documented here. Versions are published in
lockstep — a release bumps every package to the same version number, even if only some of them changed.

## [0.4.0] - 2026-08-18

### Added

- **`@moribashi/kafka`** (new package): Kafka/Redpanda transport as a standard Moribashi plugin —
  the exact analogue of `@moribashi/pg` for the event side. Zero domain knowledge: no event
  envelope, no topic naming convention, no aggregate concepts.
  - `kafkaPlugin` — registers `kafkaClient` (resolved config + connection options + registry
    client), `schemaRegistry`, and `producer` into the root container. `producer` is a
    **singleton** so core's lifecycle disconnects it via `onDestroy` on `app.stop()`, the same
    reason `pg` registers `db` as one.
  - **Framework-free core** — `createKafkaClient()` / `createProducer()` work with no Moribashi app
    at all, mirroring `createKnex()`. BYO escape hatches at every layer: an existing client
    (detected structurally), an existing `@platformatic/kafka` `Producer`, an existing registry
    client.
  - **Schema registration at boot** — `.proto` files in `schemasDir` are registered during plugin
    `register()`, which `app.start()` awaits before resolving any singleton, so an incompatible
    contract change throws before the app can serve and the pod crashloops. Unchanged schema →
    the registry returns the existing id, no-op. Missing or empty directory → warning, app starts.
  - **Declarative, not migrations** — it borrows `SqlMigrationSource`'s *ergonomics* (a directory
    of files in the service repo, processed at boot) and none of its machinery: no version
    prefixes, no ordering, no local ledger, no `down`. The registry is the ledger, which is why
    drift is impossible. Registration is **producer-scoped and opt-in** (`registerSchemas: true`) —
    a consumer registering a schema is a service asserting a contract it does not own.
  - `checkSchemaCompatibility()` — the same check as a separable, non-mutating function returning
    a report instead of throwing, so it can later run in CI and fail a PR rather than a pod. Not
    wired into CI today (Ravn's registry is in-cluster only); it exists so that wiring needs no
    new code.
  - **Per-message keys** — `send()` takes `ProducerMessage[]` where the partition key belongs to
    the message, not the batch. A batch-wide key mis-partitions every message but the first
    entity's the moment a batch spans two entities.
  - **Eager config validation** — env-driven config with no defaults for `clientId`, `brokers`, or
    `schemaRegistry.url`; a bad value throws a typed `KafkaConfigError` where `kafkaPlugin()` is
    constructed, not on the first send. `allowAutoTopicCreation` is env-only
    (`KAFKA_ALLOW_AUTO_TOPIC_CREATION`, local-dev-only) and defaults to `false`, matching the
    cluster's `auto_create_topics_enabled: false` — code cannot turn it on.
  - **SASL** — SCRAM-SHA-256/512 and PLAIN entirely from env; OAUTHBEARER via an injected
    `tokenProvider?: () => Promise<string>` that a service wires to `@moribashi/auth`'s
    `serviceToken`. **No `kafka → auth` dependency** — that edge would invert the build order. The
    provider is handed to `@platformatic/kafka` as a credential provider, so it is called per
    authentication and no token is captured at construction.
  - **Bounded schema-id cache** — `subject → schemaId` expires on a TTL (default 5 minutes, `0`
    disables) with in-flight coalescing and explicit `clearSchemaCache(subject?)`. A forever-cache
    means a registry update is never seen without a pod restart.
  - **No signal handlers** — the package never registers `SIGTERM`/`SIGINT` or calls
    `process.exit()`. Disconnection belongs to `app.stop()`, not to a transport library racing the
    service's own shutdown.
  - Errors: `KafkaError` base with `KafkaConfigError`, `SchemaRegistrationError` (carries subject
    and file), `SchemaEncodeError` (carries topic, subject, schema id).
  - Docs: [`packages/kafka/README.md`](./packages/kafka/README.md). New runtime dependencies:
    `@platformatic/kafka`, `@kafkajs/confluent-schema-registry`. A
    [`docker-compose.yml`](./packages/kafka/docker-compose.yml) provides single-node Redpanda +
    Console for the opt-in integration suite (`KAFKA_INTEGRATION=1`).

### Changed

- CI now type-checks `@moribashi/kafka` and runs its test suite.
- `CLAUDE.md`'s dependency order is now `common → core → {cli, graphql, kafka, pg, web} → auth`.

### Upgrading

**No breaking changes.** `@moribashi/kafka` is a new, opt-in package; nothing else changed. Adding
it to a service means installing it, registering `kafkaPlugin()`, and — only if the service *owns*
the subjects — dropping `.proto` files in `schemasDir` and passing `registerSchemas: true`.

## [0.3.0] - 2026-07-28

### Added

- **`@moribashi/auth`** (new package): authentication as a standard Moribashi plugin ([#14](https://github.com/moribashi/moribashi/pull/14)).
  - `authPlugin` — resource-server bearer validation against declarative multi-issuer OIDC trust
    (static key set, direct `jwksUri`, or OIDC discovery; JWKS cached per issuer via `jose`).
    Registers `principal`, `securityService`, and `authError` into the web request scope alongside
    `request`/`reply`.
  - **Capture, don't reject** — the `onRequest` hook never 401s. Missing header → anonymous principal;
    invalid/expired token → anonymous principal plus a captured typed `AuthError` that surfaces from
    `ensure*` calls with the true cause (e.g. `SessionExpiredError` instead of a generic "not
    authenticated"), so one GraphQL operation can resolve public fields while protected fields fail
    precisely.
  - **Principal model** — discriminated union: sealed `AnonymousPrincipal` singleton | immutable
    `TokenPrincipal` (`identity`, `audit`, `type`, `tid`, verified `claims`, `token()`). Token facts
    only — no authorization state on the principal.
  - **`SecurityService`** — `ensureAuthenticated()`, `hasGlobal()` from token claims, and
    `withContext(contextId)` backed by an app-registered `AccessLoader` behind a short-TTL cache
    (default 60s, in-flight coalescing, failures never cached).
  - **`workloadIdentityPlugin`** (opt-in) — registers a `serviceToken` singleton that exchanges a k8s
    projected ServiceAccount token for an IdP token via RFC 8693, refreshing ahead of expiry. No
    deployed secrets.
  - Importing `@moribashi/auth` merges `AuthCradle` into `WebRequestCradle`, so `request.scope` is
    typed with the auth services automatically.
  - Docs: [`packages/auth/README.md`](./packages/auth/README.md) (resource-server quickstart +
    k8s workload-identity guide). New runtime dependency: `jose`. No changes required in
    `@moribashi/web` or `@moribashi/graphql` — resolvers reach the service via `this.securityService`.
- **`@moribashi/web`**: fully-typed Fastify surface ([#9](https://github.com/moribashi/moribashi/pull/9)).
  - `getFastify(app)` — typed accessor returning `FastifyInstance` (replaces
    `app.resolve<FastifyInstance>('fastify')`); hook/route handler parameters now infer automatically.
  - Exported `WebCradle` / `WebRequestCradle` contracts; `request.scope` is now
    `MoribashiScope<WebRequestCradle>`; `WebConfig` is exported.
  - Expanded Fastify type re-exports (hook handlers, plugin types, `RouteOptions`,
    `RouteHandlerMethod`, `FastifyError`, `FastifyListenOptions`) so standalone handlers can be typed
    without a direct `fastify` import.

### Changed

- CI now type-checks `@moribashi/graphql` and `@moribashi/auth` and runs the auth test suite.

### Upgrading

**No breaking changes.** Both changes are additive. `@moribashi/auth` is opt-in — install it and
register `authPlugin` after `webPlugin` only if you want bearer authentication. Existing
`@moribashi/web` consumers can adopt `getFastify()` incrementally; untyped `resolve` calls still work.

## [0.2.0] - 2026-07-15

### Added

- **`@moribashi/graphql`**: `graphqlPlugin({ federated: true })` registers the schema as an Apollo
  Federation v1 subgraph (via `@mercuriusjs/federation`) instead of a standalone schema. Same
  `schema` / `resolvers` / `graphiql` options — no other API changes. SDL convention when federated: use
  `extend type Query` / `extend type Mutation` instead of `type Query` / `type Mutation`.
- **`@moribashi/graphql`**: new `gatewayPlugin()` composes federated subgraphs into one public
  supergraph via `@mercuriusjs/gateway`, as a first-class Moribashi app — DI, lifecycle hooks, and the
  plugin system all apply to it, same as any other plugin.
- **`examples/platform`**: a new runnable reference example — a gateway composing two core subgraphs
  (`identity`, `catalog`) — demonstrating the recommended shape for a team's own platform monorepo.
  Verified end-to-end (composed queries spanning both subgraphs work through the gateway).
- Design rationale doc: [`docs/federation-first-design.md`](./docs/federation-first-design.md).
- New "Phase 3 — Federation" section in
  [`docs/claude-instructions.md`](./docs/claude-instructions.md#phase-3--federation) covering: making a
  subgraph, building the gateway, the recommended core-platform-monorepo shape, adding a new team-owned
  subgraph, and shared entities across subgraphs.

### Changed

- `@moribashi/graphql`'s internal `mercurius` dependency bumped `^15` → `^16` (required by
  `@mercuriusjs/federation` / `@mercuriusjs/gateway`). This is a transitive dependency, not something
  consumers import directly — no action needed unless your project also depends on `mercurius` directly
  at an incompatible version.
- `docs/graphql-namespace-pattern.md`'s federation section now references the actual `federated: true`
  flag instead of describing federation as a purely external, later concern.
- README's package table now includes `@moribashi/graphql` (was missing entirely).

### Upgrading

**No breaking changes.** `federated` defaults to `false` — every existing `graphqlPlugin()` call site is
unaffected. Bump the version and you're done:

```sh
npm install @moribashi/graphql@0.2.0
```

To adopt federation on an existing service, see "Making a subgraph" in
[Phase 3 — Federation](./docs/claude-instructions.md#phase-3--federation) — it's a two-line change
(`federated: true`, plus `type Query` → `extend type Query`).

**Note for an agent upgrading a consumer project:** this release is additive only. Do not change any
existing `graphqlPlugin()` call sites as part of a routine version bump — only touch a service's GraphQL
wiring if the task explicitly asks for federation support. `federated` is still opt-in in this release;
it's expected to become the default in a future release (tracked upstream), which *will* be a behavior
change worth re-reading this changelog for when it lands.

## [0.1.11] and earlier

Published prior to this changelog's introduction — see git history.
