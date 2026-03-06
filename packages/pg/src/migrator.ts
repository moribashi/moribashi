import fs from 'fs/promises';
import path from 'path';
import type { Knex } from 'knex';

export interface Logger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

export type KnexMigrationSource = Knex.MigrationSource<string>;

/**
 * Parses a Flyway-style version prefix into comparable numeric parts.
 * e.g. "V1.2.3__create_users.sql" → [1, 2, 3]
 */
function parseVersion(filename: string): number[] {
  const versionStr = filename.split('__')[0].substring(1); // strip leading "V"
  const parts = versionStr.split('.').map(Number);
  if (parts.some(Number.isNaN)) {
    throw new Error(`Invalid migration filename: ${filename}`);
  }
  return parts;
}

function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Knex migration source that reads `.sql` files from a directory.
 *
 * Expects Flyway-style versioned filenames: `V<semver>__<description>.sql`
 * (e.g. `V1.0.0__create_users.sql`). Files are sorted by version number
 * and each migration runs inside a transaction.
 *
 * Down migrations are not supported — this is forward-only.
 */
const defaultLogger: Logger = {
  debug() {},
  info() {},
};

export class SqlMigrationSource implements KnexMigrationSource {
  constructor(
    private dir: string = path.join(process.cwd(), 'data', 'migrations'),
    private log: Logger = defaultLogger,
  ) {}

  async getMigrations(): Promise<string[]> {
    const files = (await fs.readdir(this.dir))
      .filter(f => f.endsWith('.sql') && f.startsWith('V'));

    this.log.debug({ dir: this.dir, files}, 'Loading migrations')
    files.sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)));

    return files;
  }

  getMigrationName(file: string): string {
    return file;
  }

  async getMigration(file: string): Promise<Knex.Migration> {
    const resolvedDir = path.resolve(this.dir);
    const fullPath = path.resolve(this.dir, file);
    if (!fullPath.startsWith(resolvedDir + '/')) {
      throw new Error('Invalid migration file path');
    }
    const sql = await fs.readFile(fullPath, 'utf-8');
    this.log.debug({ dir: this.dir, file, sql }, 'Loaded migration')

    return {
      up: async (knex: Knex) => knex.transaction(trx => trx.raw(sql)),
      down: async () => {
        throw new Error(`Down migration not supported for ${file}`);
      },
    };
  }
}
