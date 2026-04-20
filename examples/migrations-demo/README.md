# @examples/migrations-demo

Minimal example that demonstrates `@moribashi/pg`'s `SqlMigrationSource` +
`pgPlugin` — boot a `MoribashiApp`, run two Flyway-style `V*.sql` migrations
against Postgres on startup, then query through the registered `Db` helper to
prove the schema works.

> **Requires a running Postgres.** This is not a pure-DI example — the smoke
> test talks to a real database. See [CI gating](#ci-gating) below.

## What to look at

- [`src/migrations/`](./src/migrations) — two Flyway-named SQL files:
  - `V1.0.0__create_widgets.sql` creates the `widgets` table.
  - `V1.1.0__seed_widgets.sql` inserts two rows.
- [`src/app.ts`](./src/app.ts) — `buildApp()` wires `pgPlugin` with
  `migrationsDir` pointing at `src/migrations`. That's all it takes — the
  plugin constructs a `SqlMigrationSource` internally and runs
  `knex.migrate.latest()` during its async `register()` hook.
- [`src/main.ts`](./src/main.ts) — boots the app, resolves `db`, and logs the
  widget count + rows.
- [`src/__tests__/smoke.test.ts`](./src/__tests__/smoke.test.ts) — drops any
  leftover tables, boots the app (which re-applies the migrations from
  scratch), then asserts there are two rows and both migrations were recorded
  in `knex_migrations`.

## Flyway naming convention

`SqlMigrationSource` expects versioned filenames shaped like:

```
V<semver>__<description>.sql
```

e.g. `V1.0.0__create_widgets.sql`, `V1.1.0__seed_widgets.sql`,
`V2.0.0__drop_widgets.sql`. Files are sorted by the semver prefix and each
`.sql` file is wrapped in a transaction. Down migrations are not supported —
the source is forward-only.

## Run it locally

You need a Postgres reachable at `$PGHOST:$PGPORT` (defaults to `postgres:5432`
inside the repo's devcontainer, matching `packages/pg`'s own integration
tests). Override via the standard `PG*` env vars:

```sh
# Using the devcontainer's bundled postgres service:
pnpm --filter @examples/migrations-demo start

# Or against a local postgres:
PGHOST=localhost PGUSER=moribashi PGPASSWORD=password PGDATABASE=moribashi \
  pnpm --filter @examples/migrations-demo start
```

Expected output:

```
widgets table has 2 rows
  #1 alpha
  #2 beta
```

## Tests

```sh
pnpm --filter @examples/migrations-demo test
```

Each test drops `widgets`, `knex_migrations`, and `knex_migrations_lock` before
and after it runs, so the suite is repeatable against a long-lived database.

## CI gating

The smoke test is Postgres-dependent and is designed to run in the existing
`test` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) —
that job already spins up a `postgres:17` service and sets `PGHOST=localhost`
for the whole `pnpm run test` call. Because this example reuses the shared
`pg-config.ts` helper from `packages/pg/src/__tests__/`, the same
env-var-driven config covers both suites.

If you run `pnpm run test` locally without Postgres the smoke test will fail
loudly (same as `packages/pg`'s integration tests). There is no "graceful
skip" mode — if you need one, set `PGHOST` to a bogus host and expect the
failure, or filter this package out with `pnpm --filter '!@examples/migrations-demo' run test`.
