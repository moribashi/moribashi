# Progress

## Current Milestone
Post-review hardening complete — correctness, safety, testing, and API improvements applied across all phases.

## Recently Completed (4-Phase Review & Fix Cycle)

### Phase 1: Correctness
- Fixed lifecycle error handling: `start()` rollback cleans up on failure, `stop()` collects errors via AggregateError
- Fixed `start()`/`stop()` race conditions with `starting`/`stopping` flags
- Made `MoribashiScope.dispose()` idempotent via `disposed` flag
- Fixed `activeScopes` mutation during iteration (snapshot before iterating)
- Fixed web plugin double-dispose (nullify `request.scope` after dispose)
- Fixed `pgPlugin` knex pool leak (disposer on knex registration, removed `Db.onDestroy`)
- Added migration failure cleanup (destroy knex before re-throwing)

### Phase 2: Safety
- Added service name validation (regex + dangerous names denylist) in `register()`, `scope.register()`, `registerInScope()`
- Added overwrite warnings via `console.warn` for duplicate registrations
- Added async plugin registration error context wrapping
- Added path traversal protection in `SqlMigrationSource.getMigration()`
- Added malformed migration filename NaN validation in `parseVersion()`

### Phase 3: Testing
- Created 49 unit tests for `@moribashi/core` (lifecycle, plugins, scopes, validation, error handling)
- Created 11 unit tests for `@moribashi/web` (request scope lifecycle, WebServer lifecycle)
- All 60 tests passing

### Phase 4: API & DX
- Added `registerValue()` and `registerFactory()` methods to `MoribashiApp`
- Added `registerValue()` to `MoribashiScope`
- Added plugin dependency validation (`dependencies?: string[]` on `MoribashiPlugin`)
- Added duplicate plugin registration warnings

## Next Steps
- Add README and getting-started documentation
- Add GraphQL hardening options (query depth limits, introspection control)
- Add `Cradle` generic to `MoribashiApp` for typed container resolution
- Fix `scan()` for production builds (.ts vs .js extension handling)
- Add interceptor/middleware support for cross-cutting concerns
- Add testing utilities (mocking, overrides, test containers)
- Add configuration management plugin
