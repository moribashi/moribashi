# Moribashi

Lightweight TypeScript DI framework built on Awilix, with composable scopes, lifecycle hooks, and a plugin system.

## Project Structure

```
packages/
  common/   - Shared interfaces (OnInit, OnDestroy, type guards)
  core/     - DI container, plugin system, scopes, lifecycle (depends on common + awilix)
  cli/      - CLI integration (depends on core)
  graphql/  - GraphQL integration via Mercurius (depends on core, peer: fastify)
  pg/       - PostgreSQL via Knex: Db query helper, Repo/RepoQuery pattern, migrations
  web/      - Web integration (depends on core)
  k8s/      - Kubernetes-native subgraph discovery for federation gateways (depends on common, core)
examples/
  simple/   - Demo app showing container usage with lifecycle hooks + GraphQL
```

Packages have a dependency order: common → core → {cli, graphql, pg, web, k8s}. Always build in this order.

## Commands

```sh
pnpm run build                    # Build all packages (ordered)
pnpm --filter @moribashi/core run build  # Build a single package
npx tsc --noEmit -p packages/core/tsconfig.json  # Type-check a package
npx tsc --noEmit -p examples/simple/tsconfig.json  # Type-check the example
npx tsx examples/simple/src/main.ts  # Run the example
```

After modifying `packages/common/src`, rebuild it before type-checking core (core resolves common via built dist).

## Code Conventions

- ESM-first (`"type": "module"` everywhere), built with tsup to ESM + CJS
- Target: ES2024, Node >= 24
- Strict TypeScript with `verbatimModuleSyntax`
- Awilix PROXY injection mode with `strict: true`
- All services default to SINGLETON lifetime; scoped services use SCOPED
- File naming: `*.svc.ts` (services), `*.repo.ts` (repositories), `*.domain.ts` (types)
- Auto-format: `books.svc` → `booksService`, `books.repo` → `booksRepo`
- Constructor injection via destructured object: `constructor({ dep }: { dep: Dep })`
- Lifecycle hooks are duck-typed (implement `onInit()`/`onDestroy()` methods)
- Plugin interface: `{ name: string, register(app): void | Promise<void> }`
- Named scopes use `Symbol.for('moribashi.scope.<name>')` as keys
- SQL-file repos: extend `Repo`, declare `RepoQuery<E>` fields, call `this._autowire()` at end of constructor
- No decorators — keep it simple, convention-based

## Architecture Notes

- `createApp()` returns a `MoribashiApp` that wraps an Awilix container
- `app.use(plugin)` collects plugins; `app.start()` calls their `register()` in order
- `app.start()` eagerly resolves all singletons and fires `onInit`
- `app.stop()` disposes scopes, fires `onDestroy` in reverse init order, disposes root
- `app.registerInScope(key, services)` stores scoped registrations; `app.createScope(key)` applies them
- Plugins register into the one root container; scopes are opt-in for per-request/per-event isolation
- `MoribashiScope<Cradle>` is generic — the `Cradle` type param declares what's in the scope
- `scope.cradle` exposes the Awilix proxy; property access lazily resolves services
- `@moribashi/graphql` wraps resolvers so `this` is the scope cradle (services resolve lazily via `this.serviceName`)

## Session State

Track development state in `.agents/state/` to maintain context across sessions:
- `.agents/state/progress.md` — current milestone, recently completed work, next steps
- `.agents/state/decisions.md` — architectural decisions and their rationale

Update these files at the end of meaningful work sessions. When resuming development, read them first to pick up where we left off.

These files are checked into git (they double as living documentation). When rebasing before a PR, squash or drop agent state commits to keep the branch history clean — the final state of the files is what matters, not each incremental update.
