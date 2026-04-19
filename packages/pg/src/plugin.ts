import {
  asFunction,
  asValue,
  Lifetime,
  type MoribashiApp,
  type MoribashiPlugin,
} from '@moribashi/core';
import { Db } from './db.js';
import { createKnex, type PgConfig } from './knex.js';
import { SqlMigrationSource } from './migrator.js';

/**
 * Options for {@link pgPlugin}. Extends {@link PgConfig} with Moribashi-specific
 * knobs like automatic migration on startup.
 *
 * @public
 */
export interface PgPluginOptions extends PgConfig {
  /** Path to SQL migrations directory. If set, migrations run during plugin registration. */
  migrationsDir?: string;
}

/**
 * Moribashi plugin that registers `knex` and `db` as singletons
 * on the root container.
 *
 * - `knex` — the raw Knex instance for schema ops, migrations, etc.
 * - `db` — a `Db` wrapper with `query()` that returns camelCase'd rows
 *
 * If `migrationsDir` is provided, SQL migrations run automatically
 * before the app finishes starting.
 *
 * `db` is registered as a singleton so the core lifecycle calls its
 * `onDestroy` to clean up the connection pool on `app.stop()`.
 *
 * @param opts - Connection config plus optional `migrationsDir`.
 * @returns A `MoribashiPlugin` to pass to `app.use()`.
 *
 * @example
 * ```ts
 * import { createApp } from '@moribashi/core';
 * import { pgPlugin } from '@moribashi/pg';
 *
 * const app = createApp();
 * app.use(
 *   pgPlugin({
 *     connectionString: process.env.DATABASE_URL,
 *     migrationsDir: './data/migrations',
 *   }),
 * );
 * await app.start();
 * ```
 *
 * @public
 */
export function pgPlugin(opts: PgPluginOptions): MoribashiPlugin {
  const { migrationsDir, ...pgConfig } = opts;

  return {
    name: '@moribashi/pg',
    async register(app: MoribashiApp) {
      const knex = createKnex(pgConfig);

      app.container.register({
        knex: asValue(knex),
        db: asFunction(() => new Db(knex)).setLifetime(Lifetime.SINGLETON),
      });

      if (migrationsDir) {
        const source = new SqlMigrationSource(migrationsDir);
        await knex.migrate.latest({ migrationSource: source });
      }
    },
  };
}
