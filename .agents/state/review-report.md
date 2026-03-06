# Moribashi Consolidated Review Report

Four independent reviews were conducted: Security, Architecture, Usability/Code Quality, and Bug Hunting. This report synthesizes the findings into prioritized action items.

---

## Critical Findings (Fix Before Production)

### 1. Lifecycle Error Handling is Broken
**Found by: Security, Bug Hunter, Senior Dev, Architect** (unanimous)

The single most impactful issue across all reviews. Three related bugs:

- **`onInit` failure leaves app in broken state** (`core/src/index.ts:152-163`): If any service's `onInit()` throws, already-initialized services are never cleaned up. `started` stays `false`, so `stop()` no-ops. Resources leak.
- **`onDestroy` failure halts remaining cleanup** (`core/src/index.ts:173-178`): If one `onDestroy()` throws, remaining services never get destroyed and `container.dispose()` never runs.
- **Scope disposal errors prevent singleton cleanup** (`core/src/index.ts:168-171`): If any scope's `dispose()` throws during `stop()`, singletons are never cleaned up.

**Fix**: Wrap each lifecycle call in try/catch, collect errors, continue processing. On `start()` failure, auto-cleanup already-initialized services. Throw aggregate error at end.

### 2. `start()`/`stop()` Race Conditions
**Found by: Bug Hunter**

- Concurrent `start()` calls both pass the `if (started)` guard before either sets it (`core/src/index.ts:143-164`)
- Same race on `stop()` -- double `onDestroy` calls on all services (`core/src/index.ts:165-184`)

**Fix**: Add `starting`/`stopping` flags set immediately on entry.

### 3. Zero Tests for Core Framework
**Found by: Senior Dev**

`@moribashi/core`, `@moribashi/web`, `@moribashi/graphql`, `@moribashi/cli` have no tests whatsoever. Only `@moribashi/pg` has tests (and those require a live Postgres).

**Fix**: Add unit tests for `createApp()` lifecycle, plugin ordering, scope creation/disposal, error cases.

### 4. Double-Dispose on Request Scopes
**Found by: Bug Hunter, Security, Architect**

The web plugin disposes scopes in both `onResponse` and `onRequestAbort` hooks (`web/src/index.ts:88-95`). Fastify can fire both for the same request, calling `onDestroy` twice on scoped services.

**Fix**: Make `dispose()` idempotent with a `disposed` flag.

### 5. `pgPlugin` Knex Pool Leak
**Found by: Bug Hunter**

`knex` is registered via `asValue` with no lifecycle. Its cleanup depends entirely on `Db.onDestroy()`. If `Db` is never resolved, the connection pool leaks on shutdown (`pg/src/plugin.ts:30-35`).

**Fix**: Register `knex` with a disposer, or eagerly resolve `Db`.

---

## High-Priority Findings (Address Soon)

### 6. Async Plugin Registration Race Condition
**Found by: Bug Hunter, Senior Dev, Architect**

`app.use(plugin)` calls `register()` immediately. Async results are stashed and only awaited in `start()`. Code between `use()` and `start()` may or may not see async plugin registrations (`core/src/index.ts:111-117`).

**Fix**: Consider splitting into sync `register()` + async `onStart()`, or making `use()` async.

### 7. No Service Name Validation (Prototype Pollution Risk)
**Found by: Security**

`register()` passes names directly to Awilix with no validation. Keys like `__proto__`, `constructor` could cause issues (`core/src/index.ts:91-94`).

**Fix**: Validate names against a denylist or require `/^[a-zA-Z][a-zA-Z0-9]*$/`.

### 8. Silent Service Overwrites
**Found by: Security, Architect**

Calling `register()` with an existing name silently replaces the service. A later plugin can hijack earlier registrations with no warning.

**Fix**: Warn or throw on duplicate registration. Consider a `seal()` after `start()`.

### 9. `register()` Only Accepts Classes
**Found by: Senior Dev, Architect**

The high-level API only takes class constructors. Values, factories, and instances require dropping to `app.container.register()` with raw Awilix primitives. This forces a two-tier API.

**Fix**: Add `registerValue()`, `registerFactory()` methods to `MoribashiApp`.

### 10. Plugin Ordering Has No Validation
**Found by: Senior Dev, Architect**

`graphqlPlugin` will throw a cryptic Awilix error if registered before `webPlugin`. No dependency declaration mechanism exists.

**Fix**: Add optional `dependencies: string[]` to the plugin interface and validate at `start()`.

### 11. `scan()` with `.ts` Globs Breaks in Production
**Found by: Senior Dev**

Example uses `**/*.svc.ts` patterns that work under `tsx` but fail in compiled builds where files are `.js` (`examples/simple/src/main.ts:29`).

**Fix**: Document this limitation or auto-detect file extension.

---

## Medium-Priority Findings

### 12. Awilix Leaks Through the Abstraction
**Found by: Architect**

Raw `AwilixContainer` exposed on `app.container` and `scope.container`. Awilix types (`asClass`, `asValue`, `Lifetime`) re-exported. Swapping the DI library would be a breaking change for all plugins.

### 13. No Typed Cradle on `MoribashiApp`
**Found by: Architect, Senior Dev**

`MoribashiApp` has no generic parameter. `resolve<T>(name: string)` is stringly-typed with no compile-time safety. `MoribashiScope<Cradle>` has this right but `MoribashiApp` doesn't.

### 14. GraphQL: No Query Depth/Complexity Limits
**Found by: Security**

Mercurius registered without depth limits, complexity analysis, or rate limiting. GraphiQL enabled without auth gate.

### 15. Migration Path Traversal
**Found by: Security**

`getMigration(file)` accepts arbitrary strings. Could read files outside the migrations directory via `../../` (`pg/src/migrator.ts:64-65`).

### 16. `defaultFormatName` is Fragile
**Found by: Architect, Senior Dev**

Only handles two-part names. `books.special.svc.ts` loses the `svc` suffix. Unknown suffixes aren't capitalized (`books.handler` -> `bookshandler`).

### 17. Web Server Binds to 0.0.0.0 by Default
**Found by: Security**

Default `host: '0.0.0.0'` exposes to all interfaces (`web/src/index.ts:67`).

### 18. Hardcoded Credentials in Example
**Found by: Security**

DB credentials hardcoded in `examples/simple/src/main.ts:19-24`. Users will copy this pattern.

### 19. `activeScopes` Mutated During Iteration
**Found by: Bug Hunter**

`stop()` iterates `activeScopes` while `dispose()` deletes from it (`core/src/index.ts:169-171, 79`). Works by spec but fragile.

### 20. Scoped Services Never Receive `onInit`
**Found by: Architect**

Only singletons get `onInit` during `start()`. Scoped services with `onInit` are silently ignored. Not documented.

---

## Low-Priority / Opportunities

| # | Finding | Source |
|---|---------|--------|
| 21 | `@moribashi/cli` is an empty shell | Senior Dev, Architect |
| 22 | `WEB_APP_SCOPE` and `GRAPHQL_SCOPE` exported but never used | Senior Dev, Architect |
| 23 | `diagnostics()` functions return `any` and are low-value | Senior Dev |
| 24 | No README or getting-started guide in any package | Senior Dev |
| 25 | No testing utilities (mocking, overrides, test containers) | Architect |
| 26 | No interceptor/middleware support for cross-cutting concerns | Architect |
| 27 | No configuration management plugin | Architect |
| 28 | No logging abstraction (hardcoded `console.log`) | Senior Dev |
| 29 | `Db` class doesn't follow destructured constructor convention | Senior Dev |
| 30 | Duplicate `tsup.config.ts` across all packages | Senior Dev |
| 31 | No nested scope support | Architect |
| 32 | Broad caret `^` version ranges on dependencies | Security |
| 33 | Debug endpoint exposes module info without auth | Security |
| 34 | Example requires live Postgres with no setup docs | Senior Dev |
| 35 | `@moribashi/pg` not listed in CLAUDE.md project structure | Senior Dev |

---

## Recommended Action Plan

### Phase 1: Correctness (Week 1)
1. Fix lifecycle error handling (Finding 1) -- wrap in try/catch, cleanup on failure
2. Fix start/stop race conditions (Finding 2) -- add state flags
3. Make scope `dispose()` idempotent (Finding 4) -- add `disposed` guard
4. Fix `activeScopes` iteration safety (Finding 19) -- copy before iterating
5. Fix `pgPlugin` knex pool leak (Finding 5) -- add disposer

### Phase 2: Safety (Week 2)
6. Add service name validation (Finding 7)
7. Warn on service overwrites (Finding 8)
8. Fix async plugin timing (Finding 6)
9. Add path traversal protection to migrator (Finding 15)
10. Make `dispose()` safe against double-call everywhere

### Phase 3: Testing (Week 3)
11. Add core unit tests -- lifecycle, plugins, scopes, error cases
12. Add web plugin tests -- request scope lifecycle
13. Add GraphQL plugin tests -- resolver binding, scope integration
14. Set up vitest config and root test script

### Phase 4: API & DX (Week 4+)
15. Expand `register()` to handle values/factories (Finding 9)
16. Add plugin dependency declaration (Finding 10)
17. Add `Cradle` generic to `MoribashiApp` (Finding 13)
18. Add README and getting-started documentation
19. Fix `scan()` for production builds (Finding 11)
20. Add GraphQL hardening options (Finding 14)
