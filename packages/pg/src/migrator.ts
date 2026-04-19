import fs from 'node:fs/promises';
import path from 'node:path';
import type { Knex } from 'knex';

/**
 * Minimal structural logger interface compatible with `pino` / `fastify.log`.
 * Used by {@link SqlMigrationSource} and {@link fastifyKnex} to report
 * migration activity. Pass any logger that exposes `debug` / `info` methods
 * with the usual `(obj, msg)` signature.
 */
export interface Logger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Convenience alias for `Knex.MigrationSource<string>` — the shape Knex
 * expects when you supply a custom migration source. {@link SqlMigrationSource}
 * implements this.
 */
export type KnexMigrationSource = Knex.MigrationSource<string>;

/**
 * Parses a Flyway-style version prefix into comparable numeric parts.
 * e.g. "V1.2.3__create_users.sql" → [1, 2, 3]
 */
function parseVersion(filename: string): number[] {
  const versionStr = filename.split('__')[0].substring(1); // strip leading "V"
  return versionStr.split('.').map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const defaultLogger: Logger = {
  debug() {},
  info() {},
};

/**
 * Knex migration source that reads `.sql` files from a directory.
 *
 * Expects Flyway-style versioned filenames: `V<semver>__<description>.sql`
 * (e.g. `V1.0.0__create_users.sql`). Files are sorted by version number
 * and each migration runs inside a transaction.
 *
 * Down migrations are not supported — this is forward-only.
 *
 * @example
 * ```ts
 * import { createKnex, SqlMigrationSource } from '@moribashi/pg';
 *
 * const knex = createKnex({ connectionString: process.env.DATABASE_URL });
 * const source = new SqlMigrationSource('./data/migrations');
 * await knex.migrate.latest({ migrationSource: source });
 * ```
 *
 * @public
 */
export class SqlMigrationSource implements KnexMigrationSource {
  /**
   * @param dir - Absolute or cwd-relative path to the directory containing
   *   `V*.sql` files. Defaults to `<cwd>/data/migrations`.
   * @param log - Optional structural logger; defaults to a no-op.
   */
  constructor(
    private dir: string = path.join(process.cwd(), 'data', 'migrations'),
    private log: Logger = defaultLogger,
  ) {}

  /**
   * Returns the list of migration filenames (not full paths), sorted by
   * their Flyway-style version prefix. Files not starting with `V` or not
   * ending in `.sql` are ignored.
   */
  async getMigrations(): Promise<string[]> {
    const files = (await fs.readdir(this.dir)).filter(
      (f) => f.endsWith('.sql') && f.startsWith('V'),
    );

    this.log.debug({ dir: this.dir, files }, 'Loading migrations');
    files.sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)));

    return files;
  }

  /**
   * Returns the canonical name Knex records in its migrations table.
   * @param file - Filename returned from {@link getMigrations}.
   */
  getMigrationName(file: string): string {
    return file;
  }

  /**
   * Loads a single migration, wrapping the SQL in a transaction on `up` and
   * throwing on `down` (this source is forward-only).
   *
   * @param file - Filename returned from {@link getMigrations}.
   */
  async getMigration(file: string): Promise<Knex.Migration> {
    const sql = await fs.readFile(path.join(this.dir, file), 'utf-8');
    this.log.debug({ dir: this.dir, file, sql }, 'Loaded migration');

    return {
      up: async (knex: Knex) => knex.transaction((trx) => trx.raw(sql)),
      down: async () => {
        throw new Error(`Down migration not supported for ${file}`);
      },
    };
  }
}
