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

## Flags: OpenFeature wrapper, provider is the only knob (GH #17)
- `@moribashi/flags` wraps `@openfeature/server-sdk`. Deliberately a leaf package, NOT part of core: core carries no third-party deps beyond awilix and is the graph root; adding OpenFeature there would tax every consumer (CLI/workers). A one-line `app.use(flagsPlugin())` with a working default achieves "feels core" without the coupling — same call as web/pg/auth.
- Pluggability is OpenFeature's own `Provider` seam, not something we invent. One pure `resolveProvider(opts)`, precedence `provider` > `ofrep` > in-memory:
  - `provider` — any OpenFeature provider (vendor SDK / custom). Full escape hatch.
  - `ofrep: { baseUrl }` — the recommended production default: standards-based (OFREP is a REST contract, not a vendor), configured by URL only. Provider imported lazily (`await import`) so apps that don't use it never load or need the peer.
  - neither → bundled `InMemoryProvider` (ships inside server-sdk, so the default is truly dep-free). Guarantees an app ALWAYS has a working flag client — great for tests/local/air-gapped.
- Lifecycle reuse, no new concepts: a `FeatureProviderLifecycle` singleton calls `setProviderAndWait` in `onInit` (so `app.start()` gates on the provider being READY, exactly like pg migrations) and `OpenFeature.clearProviders()` in `onDestroy`.
- Per-request context mirrors the auth hook: an `onRequest` hook (register flags AFTER authPlugin) reads `principal` off the request scope and registers `evaluationContext` (default `targetingKey = principal.identity`, plus tid/type). Root registers an empty `evaluationContext` so the SCOPED `Flags` service resolves cleanly under Awilix strict mode even with no web.
- Soft deps, structural coupling: web + auth are optional peers. `PrincipalLike` is a structural type (not an import of auth's `Principal`), so flags has zero dependency on auth — any object with `identity`/`tid`/`type` works, and an app with no auth just gets the empty context.
- Packaging: `@openfeature/server-sdk` direct dep (defines our public `Provider`/`Client`/`EvaluationContext` types, re-exported); `@openfeature/ofrep-provider` and `@moribashi/web` are optional peers (`peerDependenciesMeta.optional`) + devDeps.
- Rejected the AsyncLocalStorage transaction-context propagator as the default: it's a second, global, implicit request-context mechanism competing with Moribashi's explicit DI scopes. Could be offered later as an opt-in.
