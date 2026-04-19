import knex, { type Knex } from 'knex';

export type { Knex };

/**
 * Connection + pool config for a Postgres Knex instance created by
 * {@link createKnex} and, by extension, by `pgPlugin` and `fastifyKnex`.
 *
 * Either supply a full `connectionString` or the individual host/port/user/
 * password/database fields. Defaults target `localhost:5432` as `postgres`.
 */
export interface PgConfig {
  /** PostgreSQL connection string, e.g. `postgres://user:pass@localhost:5432/mydb` */
  connectionString?: string;
  /** Individual connection parameters (used when connectionString is not provided) */
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** Connection pool settings (defaults to `{ min: 2, max: 10 }`). */
  pool?: {
    min?: number;
    max?: number;
  };
  /** Enable debug logging for knex queries. */
  debug?: boolean;
  /** Search path / schemas passed through to Knex. */
  searchPath?: string[];
}

/**
 * Create a Knex instance configured for the `pg` client using {@link PgConfig}.
 * Used internally by {@link pgPlugin} and {@link fastifyKnex}; exported for
 * tests and bespoke setups where you want to manage Knex yourself.
 *
 * @param config - Connection and pool options.
 * @returns A ready-to-use `Knex` instance bound to the `pg` client.
 *
 * @example
 * ```ts
 * const knex = createKnex({ connectionString: process.env.DATABASE_URL });
 * const { rows } = await knex.raw('SELECT now()');
 * ```
 */
export function createKnex(config: PgConfig): Knex {
  const connection = config.connectionString ?? {
    host: config.host ?? 'localhost',
    port: config.port ?? 5432,
    user: config.user ?? 'postgres',
    password: config.password ?? '',
    database: config.database ?? 'postgres',
  };

  return knex({
    client: 'pg',
    connection,
    pool: config.pool ?? { min: 2, max: 10 },
    debug: config.debug ?? false,
    searchPath: config.searchPath,
  });
}
