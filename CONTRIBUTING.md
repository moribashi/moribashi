# Contributing to Moribashi

Thanks for your interest in contributing! Moribashi is a lightweight TypeScript DI framework built on Awilix — see the [root README](./README.md) for an overview, quick start, and architecture notes.

This guide covers how to set up the repo, the expected workflow, and the checklist your pull request should satisfy before review.

## Development setup

1. Install dependencies:

   ```sh
   pnpm install
   ```

2. Requirements:
   - **Node.js** >= 24
   - **pnpm** (the repo pins a version via the `packageManager` field in `package.json`)
   - **PostgreSQL** — required to run the `@moribashi/pg` integration tests. CI provisions a Postgres service automatically; locally it is optional (the pg tests will be skipped if no database is reachable). If you want to run them, point the pg package at a local Postgres via the environment variables documented in `packages/pg/README.md`.

3. Build all packages (ordered, respecting the dependency graph):

   ```sh
   pnpm run build
   ```

## Repo layout

The monorepo is organized as a set of packages with a strict dependency order: **`common` → `core` → { `cli`, `graphql`, `pg`, `web` }**. Always build in that order.

```
packages/
  common/   Shared interfaces (OnInit, OnDestroy, type guards)
  core/     DI container, plugin system, scopes, lifecycle (depends on common + awilix)
  cli/      CLI integration (depends on core)
  graphql/  GraphQL integration via Mercurius (depends on core, peer: fastify)
  pg/       PostgreSQL via Knex: Db query helper, Repo/RepoQuery pattern, migrations
  web/      Web integration (depends on core)
examples/
  simple/            Minimal demo app
  scoped-services/   Per-request scope isolation
  custom-plugin/     Authoring a plugin
  error-handling/    Lifecycle + error patterns
  graphql-server/    End-to-end GraphQL app
  migrations-demo/   pg migrations walkthrough
```

## Workflow

1. Branch from `main`:

   ```sh
   git switch -c my-change main
   ```

2. Make your edits, then run the full local verification:

   ```sh
   pnpm ci:check && pnpm typecheck && pnpm test
   ```

   - `pnpm ci:check` — Biome format + lint (CI mode)
   - `pnpm typecheck` — TypeScript `--noEmit` across every package and example
   - `pnpm test` — Vitest across the workspace

3. Open a pull request against `main` with:
   - A short summary of what changed and **why**
   - A test plan (commands you ran, scenarios you verified)
   - Screenshots or logs if the change is user-visible

## Pull request checklist

Before requesting review, confirm:

- [ ] Tests added/updated for the behavior change
- [ ] JSDoc added for new public exports (enforced by TypeDoc in CI)
- [ ] `pnpm ci:check` clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` green
- [ ] Examples smoke tests green (if touching user-facing API)
- [ ] Changeset added (`pnpm changeset`) for user-facing changes

## Semver policy

Moribashi uses stability markers in JSDoc to describe the guarantees for each exported symbol:

- **`@public`** — Stable, public API. These exports follow **strict semver**: breaking changes require a **major** version bump.
- **`@experimental`** — Work-in-progress. These exports **may break in a minor release**. Use at your own risk; pin versions accordingly.

The authoritative surface is declared in each package's `src/index.ts`. Consult the inline JSDoc stability tags there for the current state of every export.

When in doubt about whether a change is breaking, err on the side of caution: if downstream code importing a `@public` symbol could stop compiling or change behavior, it's breaking, and the changeset should be labeled `major`.
