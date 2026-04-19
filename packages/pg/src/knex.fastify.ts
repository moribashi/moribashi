import fp from 'fastify-plugin';
import type { Knex } from 'knex';
import { createKnex, type PgConfig } from './knex.js';
import { type Logger, SqlMigrationSource } from './migrator.js';

/**
 * Options for {@link fastifyKnex}. Extends {@link PgConfig} with the
 * decorator name and an optional migrations directory.
 */
export interface KnexPluginOptions extends PgConfig {
  /** Decorator name on the Fastify instance. Defaults to `'knex'`. */
  decoratorId?: string;
  /** Path to SQL migrations directory. If set, migrations run on server ready. */
  migrationsDir?: string;
}

async function runMigrations(dir: string, log: Logger, knex: Knex) {
  const source = new SqlMigrationSource(dir, log);
  const migrations = await source.getMigrations();
  log.info({ dir, count: migrations.length }, 'Running SQL migrations');
  await knex.migrate.latest({ migrationSource: source });
}

/**
 * Fastify plugin that creates a Knex instance and decorates it onto the
 * Fastify server. Optionally runs SQL migrations on server ready.
 *
 * Cleans up the connection pool on server close.
 *
 * Most Moribashi apps should prefer {@link pgPlugin}, which registers `knex`
 * and `db` into the core DI container. Use `fastifyKnex` when you're running
 * Fastify without the Moribashi container.
 *
 * @example
 * ```ts
 * import Fastify from 'fastify';
 * import { fastifyKnex } from '@moribashi/pg';
 *
 * const app = Fastify();
 * await app.register(fastifyKnex, {
 *   connectionString: process.env.DATABASE_URL,
 *   migrationsDir: './data/migrations',
 * });
 * // app.knex is now available
 * ```
 */
export const fastifyKnex = fp<KnexPluginOptions>(
  async (fastify, opts) => {
    const { decoratorId = 'knex', migrationsDir, ...pgConfig } = opts;
    const knex = createKnex(pgConfig);

    fastify.decorate(decoratorId, knex);

    if (migrationsDir) {
      fastify.addHook('onReady', async () => {
        await runMigrations(migrationsDir, fastify.log, knex);
      });
    }

    fastify.addHook('onClose', async () => {
      await knex.destroy();
    });
  },
  { name: '@moribashi/pg-knex' },
);
