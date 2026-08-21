# Changelog

All notable changes to the `@moribashi/*` packages are documented here. Versions are published in
lockstep — a release bumps every package to the same version number, even if only some of them changed.

## [Unreleased]

### Fixed

- **`@moribashi/kafka`: protobuf messages were written with non-standard framing.**
  `@kafkajs/confluent-schema-registry` emits `magic | schemaId | payload` and omits the protobuf
  **message-index array** the Confluent wire format requires between the schema id and the payload.
  Found in production on `iam.identity.created.v1`; the first twelve bytes were

  ```
  00 00 00 00 08 0a 24 66 62 65 31 37
     ^ magic    ^ id  ^ should be 0x00 (the index array); 0x0a is already a protobuf field tag
  ```

  It only ever broke *other* consumers. Producer and consumer both omitted the same bytes, so every
  test passed while Redpanda Console showed `UTF8WITHCONTROLCHARS` and any standard Confluent
  deserializer — Java, Go, Python, C# — read garbage.

  The fix replaces the library with **`@confluentinc/schemaregistry`**, Confluent's official Node
  client. The same message now frames as `00 00 00 00 13 00 0a 06 …` — magic, id, `0x00` index
  array, payload. `src/__tests__/wire-format.test.ts` asserts the prefix byte for byte and runs with
  no broker; the integration suite additionally reads the topic back **in a separate process** using
  a stock Confluent deserializer that imports nothing from this package.

- **`@moribashi/kafka`: nested and enum fields decoded as garbage.** Redpanda's registry returns
  `?format=serialized` descriptors in which a message- or enum-typed field carries only `type_name`,
  leaving `type` unset for the reader to infer. `@bufbuild/protobuf` does not infer it and links the
  field as a scalar, so a nested message decoded as a NaN double. Registry descriptors are now
  repaired before they are linked (`src/descriptors.ts`); a type that cannot be resolved throws
  instead of decoding wrongly.

### Changed

- **`@moribashi/kafka`: `ProducerMessage.value` is a Buf-generated protobuf message.**
  `@confluentinc/schemaregistry` is built on `@bufbuild/protobuf` — the same runtime Buf generates
  against — so the generated message type now feeds the serializer directly and the `.proto` is
  parsed once instead of twice. A plain object still works, and is initialised into the message type
  declared for its topic, but with **generated field names**: `display_name` in the `.proto` is
  `displayName` in the payload.
- **`@moribashi/kafka`: new required `messages` option** on `kafkaPlugin` / `kafkaConsumerPlugin` /
  `createKafkaClient` — `Record<topic, GeneratedMessageSchema>`, for every topic a client produces
  to. The serializer resolves a message's descriptor from it, and it makes producing the wrong event
  type to a topic an error rather than a coincidence. Consumers need none of it: decoding resolves
  the writer's descriptor from the schema id on the wire.
- **`@moribashi/kafka`: decoded values are `@bufbuild/protobuf` messages**, carrying `$typeName` and
  generated field names, where they used to be plain protobufjs objects with `.proto` field names.
  Consumers reading `event.value` see this.
- **`@moribashi/kafka`: the `SchemaRegistryClient` seam is topic-scoped.** `encode(topic, value)` and
  `decode(topic, payload)` replace `encode(schemaId, payload)` and `decode(payload)` —
  Confluent's serde derives the subject itself rather than taking a pre-resolved id. `register()`
  takes `(subject, schema)` and returns the id directly; `clearCaches()` replaces nothing and
  `getLatestSchemaId()` stays.
- **`@moribashi/kafka`: `schemaCacheTtlMs` and `subjectFor` moved from `createProducer()` options to
  client config**, since the registry client now owns id resolution and both sides of the wire need
  the same subject derivation. `schemaCacheTtlMs` becomes the Confluent client's
  `cacheLatestTtlSecs`. `producer.clearSchemaCache(subject?)` still exists but clears every cached
  lookup — the underlying cache is not keyed by subject alone.
- **`@moribashi/kafka`: new exports** `readWirePrefix()` and `MAGIC_BYTE`, for asserting what a
  producer actually put on the wire without hand-rolling varint reading.

### Notes

- Boot-time schema registration is **unchanged and still mandatory**. Confluent's serializer will
  auto-register a subject on first send; it is configured with `autoRegisterSchemas: false` and
  `useLatestVersion: true` so it cannot. An incompatible contract still fails inside plugin
  `register()`, which `app.start()` awaits before the port binds — rather than on the first produce,
  which in svc-iam happens inside Keycloak's token-mint path.
- `checkSchemaCompatibility()` is untouched: still separable, still non-mutating, still a report
  rather than a throw.
- `@confluentinc/schemaregistry` brings AWS/Azure/GCP KMS SDKs, Vault, `simple-oauth2` and `jsonata`
  with it, for field-level encryption and data contracts this package does not use. That weight was
  accepted deliberately in exchange for framing that other consumers can read.

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

- **`@moribashi/kafka`**: the consumer side — `kafkaConsumerPlugin`, a second opt-in plugin
  registering a `consumer` singleton that joins the group on `app.start()` and drains on
  `app.stop()`. It reuses the `kafkaClient` `kafkaPlugin` already registered, so a service that
  both produces and consumes has one place for broker config to be wrong.
  - **Per-message DI scope** — `EVENT_SCOPE` (`Symbol.for('moribashi.scope.event')`), the
    event-side counterpart of `@moribashi/web`'s request scope. A scope per message carrying
    `event` (topic, partition, offset, key + raw key, decoded value + raw value, headers,
    timestamp, correlation id, attempt) and `correlationId`, disposed once the handler settles.
    Register services with `app.registerInScope(EVENT_SCOPE, …)` and type them by merging into
    the exported `EventCradle`. A retry gets a *fresh* scope — a handler that threw halfway may
    have left scoped state half-applied.
  - **Correlation id** — taken from the `x-correlation-id` header (case-insensitively; the same
    header the HTTP side uses, so one id spans a request and the events it causes) and generated
    when absent. Configurable via `correlationIdHeader`.
  - **At-least-once commit** — the offset moves only after the handler resolves. Auto-commit is
    explicitly disabled, since `@platformatic/kafka` defaults it to *on*. **Handlers must be
    idempotent**; a failed commit is logged loudly and the message is redelivered.
  - **Handler binding, both ways** — an explicit `handlers` topic → DI-name map *and*
    `*.handler.ts` convention discovery (core's existing `app.scan()` / `formatName` mechanism;
    the handler declares its own `topic`). Both on by default, explicit wins on conflict, and a
    topic bound twice by convention is a `HandlerBindingError` at startup rather than
    last-one-wins. Resolution happens at `onInit`, so `app.scan()` may run after `app.use()`.
    Subscriptions are derived from the bindings — no second list to keep in sync.
  - **Failure policy** — `'throw' | 'skip' | { dlq }`, applied identically to decode failures and
    handler throws. Default is `{ dlq }` when a DLQ topic is configured, `'throw'` otherwise;
    `failurePolicy: 'skip'` is a one-liner. Bounded in-process retry runs first (`maxRetries`,
    default 3, exponential backoff capped by `retryMaxBackoffMs`) so a registry blip never
    reaches the DLQ. `consumer.stats` exposes
    `{ received, processed, retried, skipped, dlq, failed }`.
  - **`'throw'` means *stop consuming*, not "propagate and retry"** — with commit-after-handler,
    naive propagation redelivers the poison message forever. Instead the run loop ends, queued
    messages are abandoned rather than committed (committing a later offset in the same partition
    would skip past the uncommitted poison message and lose it), `consumer.finished` rejects, and
    `onFatal` fires — logging and rethrowing by default so the pod restarts visibly. The partition
    is wedged either way; this makes it a diagnosable outage instead of a silent one, which is why
    `{ dlq }` is the better default once a service has somewhere to put failures.
  - **DLQ messages carry the original bytes**, key included — re-encoding something that failed to
    decode is impossible — plus failure context in `x-moribashi-dlq-*` headers (original
    topic/partition/offset, error and error name, attempt count, group id, timestamp). A failing
    DLQ publish is fatal rather than a silent drop. **The DLQ topic must be declared** in the
    service's `topics:` values; the cluster does not auto-create.
  - **Concurrency** — strictly sequential within a partition (ordering is what the partition key
    buys), parallel across partitions, globally bounded by `concurrency` (default 4).
  - **Consumers never register schemas** — decoding is a registry lookup by schema id off the
    Confluent framing, not a registration.
  - Lifecycle mirrors the producer: `onInit`/`onDestroy` through the app, no signal handlers, and
    `stop()` waits for handlers already running before disconnecting.
  - New errors: `SchemaDecodeError`, `EventHandlerError`, `HandlerBindingError` — all
    `KafkaError`s, all carrying the message coordinates where they have them.

### Changed

- CI now type-checks `@moribashi/kafka` and runs its test suite.
- `CLAUDE.md`'s dependency order is now `common → core → {cli, graphql, kafka, pg, web} → auth`.

### Upgrading

**No breaking changes.** `@moribashi/kafka` is a new, opt-in package; nothing else changed. Adding
it to a service means installing it, registering `kafkaPlugin()`, and — only if the service *owns*
the subjects — dropping `.proto` files in `schemasDir` and passing `registerSchemas: true`.
Consuming is a second, independent opt-in: register `kafkaConsumerPlugin({ groupId, dlq })` and
either scan `*.handler.ts` files or pass an explicit `handlers` map. Handlers must be idempotent —
delivery is at-least-once.

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
