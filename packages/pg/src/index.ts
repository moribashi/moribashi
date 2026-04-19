/**
 * Postgres integration for Moribashi.
 *
 * Provides:
 * - {@link pgPlugin} — registers `knex` and `db` on the Moribashi container.
 * - {@link Db} — thin Knex wrapper with a camelCase-returning `query()` helper.
 * - {@link Repo} / {@link RepoQuery} — SQL-file-driven repository pattern.
 * - {@link SqlMigrationSource} — Flyway-style `V*.sql` migration source for Knex.
 * - {@link fastifyKnex} — standalone Fastify plugin for non-DI setups.
 *
 * @packageDocumentation
 */
export { Db, Repo, RepoQuery } from './db.js';
export { fastifyKnex, type KnexPluginOptions } from './knex.fastify.js';
export { createKnex, type Knex, type PgConfig } from './knex.js';
export { type KnexMigrationSource, SqlMigrationSource } from './migrator.js';
export { type PgPluginOptions, pgPlugin } from './plugin.js';

/**
 * Returns a small identity object used by debug routes / smoke tests to
 * confirm that this package is loaded.
 */
export function diagnostics() {
  return { module: '@moribashi/pg' };
}
