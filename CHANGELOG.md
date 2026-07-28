# Changelog

All notable changes to the `@moribashi/*` packages are documented here. Versions are published in
lockstep — a release bumps every package to the same version number, even if only some of them changed.

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
