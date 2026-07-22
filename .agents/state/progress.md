# Progress

## Current Milestone
Federation support (opt-in) — `@moribashi/graphql` can register a schema as an Apollo Federation v1
subgraph and compose subgraphs via a new gateway plugin. Not yet the default (see Next Steps).

## Recently Completed
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
- Flip `graphqlPlugin()`'s `federated` default to `true` in a future release (tracked: GH #4) — needs a consumer inventory first since it's a behavior change
- Gateway subgraph discovery/composition automation — currently a manual step (edit the gateway's `subgraphs` list); deliberately deferred, tracked separately (GH #3, noted in GH #5's scope too)
- Shared-entity (`@key` / `__resolveReference`) pattern is documented but unimplemented anywhere in this repo — design it once a real cross-subgraph entity need shows up, not speculatively
- `@moribashi/cli` remains an unimplemented stub — scaffolding tooling for new subgraphs/platforms was explicitly deferred, not in scope for this round
- Build concrete scope plugins (WebContext via `@moribashi/web`, EventContext for Kafka)
- Add scoped service lifecycle hooks (onInit/onDestroy within scopes)
- Middleware/interceptor support
- Migrate example app repos to use `Repo`/`RepoQuery` pattern
