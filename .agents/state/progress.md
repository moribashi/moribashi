# Progress

## Current Milestone
Event transport — `@moribashi/kafka` provides a Kafka/Redpanda producer as a standard plugin:
protobuf schema registration at boot against the Confluent Schema Registry, per-message keying,
and disconnection through the app lifecycle. Slated for the 0.4.0 lockstep train.

## Recently Completed
- Built `@moribashi/kafka` (new package, 0.4.0): `kafkaPlugin` registering `kafkaClient`/`schemaRegistry`/`producer` (producer a singleton so `app.stop()` disconnects it), a framework-free core (`createKafkaClient`/`createProducer`) mirroring `createKnex`, declarative `.proto` registration at boot with the registry as the ledger, a separable `checkSchemaCompatibility()` for a future CI gate, per-message partition keys, a TTL-bounded `subject → schemaId` cache, and SASL (SCRAM/PLAIN from env, OAUTHBEARER via an injected `tokenProvider` so there is no `kafka → auth` edge)
- 209 tests for kafka: 202 unit (config + failure modes, connection-option mapping, schema registration including the incompatible-schema and missing-directory paths, producer encode/send/keying/caching, plugin DI + lifecycle, barrel, plus a dedicated adversarial suite) and 7 opt-in integration tests verified against a real single-node Redpanda + Schema Registry — including the full Confluent protobuf wire round-trip, registration idempotency, and the incompatible-change rejection
- Producer-only for 0.4.0 by design; `createConsumer()` deferred until the `EventContext` scope story, commit semantics, and a decode-failure policy are settled (see decisions.md)
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
- Auth follow-ups deferred by GH #11: session/cookie auth, opaque-token introspection (RFC 7662), impersonation semantics (claim shape reserves `audit` vs `identity`), GraphQL schema directives
- Flip `graphqlPlugin()`'s `federated` default to `true` in a future release (tracked: GH #4) — needs a consumer inventory first since it's a behavior change
- Gateway subgraph discovery/composition automation — currently a manual step (edit the gateway's `subgraphs` list); deliberately deferred, tracked separately (GH #3, noted in GH #5's scope too)
- Shared-entity (`@key` / `__resolveReference`) pattern is documented but unimplemented anywhere in this repo — design it once a real cross-subgraph entity need shows up, not speculatively
- `@moribashi/cli` remains an unimplemented stub — scaffolding tooling for new subgraphs/platforms was explicitly deferred, not in scope for this round
- Consumer side of `@moribashi/kafka`: `createConsumer()` plus the `EventContext` scope plugin (per-message DI scope), offset/commit semantics, and a decode-failure policy (DLQ vs crash) — deliberately deferred out of 0.4.0
- Wire `checkSchemaCompatibility()` into CI once the Schema Registry is reachable from GitHub Actions (in-cluster only today), so an incompatible contract change fails a PR instead of a pod
- Build concrete scope plugins (WebContext via `@moribashi/web`, EventContext for Kafka)
- Add scoped service lifecycle hooks (onInit/onDestroy within scopes)
- Middleware/interceptor support
- Migrate example app repos to use `Repo`/`RepoQuery` pattern
