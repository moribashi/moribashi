import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@moribashi/core';
import { type PgPluginOptions, pgPlugin } from '@moribashi/pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the Flyway-style migrations directory shipped with the example. */
export const migrationsDir = path.join(__dirname, 'migrations');

export interface BuildAppOptions {
  /**
   * Overrides for the Postgres connection. Any field can be overridden;
   * anything omitted falls back to the standard `PG*` env vars (matching the
   * same convention `@moribashi/pg`'s own integration tests use).
   */
  pg?: Partial<PgPluginOptions>;
}

/**
 * Wire up the migrations-demo app without starting it.
 *
 * Hands `migrationsDir` to `pgPlugin`, so when `app.start()` runs the plugin's
 * async `register()` hook calls `knex.migrate.latest({ migrationSource: new
 * SqlMigrationSource(migrationsDir) })` before the app finishes starting —
 * i.e. the example ACTUALLY MIGRATES on boot.
 */
export function buildApp(opts: BuildAppOptions = {}) {
  const app = createApp();

  app.use(
    pgPlugin({
      host: process.env.PGHOST ?? 'postgres',
      port: Number(process.env.PGPORT ?? 5432),
      user: process.env.PGUSER ?? 'moribashi',
      password: process.env.PGPASSWORD ?? 'password',
      database: process.env.PGDATABASE ?? 'moribashi',
      migrationsDir,
      ...opts.pg,
    }),
  );

  return app;
}
