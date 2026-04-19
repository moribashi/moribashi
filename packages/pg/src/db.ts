import fs from 'node:fs';
import path from 'node:path';
import camelcaseKeys, { type Options as CamelCaseOptions } from 'camelcase-keys';
import type { Knex } from 'knex';

/**
 * Thin wrapper around a Knex instance that provides a `query()` helper
 * returning camelCase'd rows. Registered as a singleton by `pgPlugin`.
 *
 * Implements `onDestroy` so the connection pool is cleaned up when the
 * Moribashi app stops.
 *
 * @example
 * ```ts
 * interface BookRow { id: number; title: string; authorId: number; }
 *
 * class BooksRepo {
 *   constructor({ db }: { db: Db }) { this.db = db; }
 *   findByAuthor(authorId: number) {
 *     return this.db.query<BookRow>(
 *       'SELECT id, title, author_id FROM books WHERE author_id = :authorId',
 *       { authorId },
 *     );
 *   }
 * }
 * ```
 *
 * @public
 */
export class Db {
  constructor(public knex: Knex) {}

  /**
   * Run a raw SQL query with named params, returning camelCase'd rows.
   *
   * Column names from Postgres (typically snake_case) are converted to camelCase
   * via `camelcase-keys` with `deep: true` so nested JSON/JSONB objects are also
   * normalised. Pass `camelCaseOpts` to override.
   *
   * @typeParam T - Row shape (in camelCase).
   * @param sql - SQL text. Supports Knex `:name` binding syntax.
   * @param params - Named parameters referenced by `sql`.
   * @param camelCaseOpts - Overrides forwarded to `camelcase-keys`.
   * @returns An array of rows typed as `T`.
   */
  async query<T extends object>(
    sql: string,
    params?: Record<string, unknown>,
    camelCaseOpts?: CamelCaseOptions,
  ): Promise<T[]> {
    const { rows } = (await this.knex.raw(sql, params ?? {})) as { rows: T[] };
    return rows.map((r) => camelcaseKeys<T>(r, { deep: true, ...camelCaseOpts }) as T);
  }

  /**
   * Lifecycle hook invoked by Moribashi's core on `app.stop()`.
   * Destroys the underlying Knex connection pool.
   */
  async onDestroy(): Promise<void> {
    await this.knex.destroy();
  }
}

/**
 * A single parameterised SQL query, wired to a {@link Db} and a `.sql` file
 * by {@link Repo} + {@link autowireRepo}. Offers four row-cardinality helpers
 * — `one`, `many`, `any`, `none` — that throw when the result set doesn't
 * match the expected shape.
 *
 * Instances are typically declared as class fields on a `Repo` subclass;
 * the SQL text and `Db` reference are populated when the subclass calls
 * `this._autowire()` in its constructor.
 *
 * @typeParam E - Row shape (in camelCase) returned by the query.
 *
 * @example
 * ```ts
 * class BooksRepo extends Repo {
 *   findById = new RepoQuery<Book>();        // wired to ./sql/findById.sql
 *   constructor({ db }: { db: Db }) {
 *     super(import.meta.dirname, db);
 *     this._autowire();
 *   }
 * }
 *
 * const book = await booksRepo.findById.one({ id: 1 });
 * ```
 *
 * @experimental The Repo/RepoQuery pattern may evolve in a future release.
 */
export class RepoQuery<E extends object> {
  public sql?: string;
  public db?: Db;

  private _ensureInit() {
    if (!this.sql) {
      throw new Error('Missing SQL');
    }
    if (!this.db) {
      throw new Error('Missing DB');
    }
  }

  private _query(params?: Record<string, unknown>): Promise<E[]> {
    this._ensureInit();
    return this.db!.query<E>(this.sql!, params ?? {});
  }

  /**
   * Returns exactly one row. Throws if 0 or more than 1.
   * @param params - Named parameters for the SQL.
   */
  async one(params?: Record<string, unknown>): Promise<E> {
    const rows = await this._query(params);
    if (rows.length !== 1) {
      throw new Error(`Expected exactly one row, got ${rows.length}`);
    }
    return rows[0];
  }

  /**
   * Returns 0 or more rows. Never throws on count.
   * @param params - Named parameters for the SQL.
   */
  async any(params?: Record<string, unknown>): Promise<E[]> {
    return this._query(params);
  }

  /**
   * Returns 1 or more rows. Throws if 0.
   * @param params - Named parameters for the SQL.
   */
  async many(params?: Record<string, unknown>): Promise<E[]> {
    const rows = await this._query(params);
    if (rows.length === 0) {
      throw new Error('Expected one or more rows, got 0');
    }
    return rows;
  }

  /**
   * Expects 0 rows. Throws if any rows are returned.
   * @param params - Named parameters for the SQL.
   */
  async none(params?: Record<string, unknown>): Promise<void> {
    const rows = await this._query(params);
    if (rows.length > 0) {
      throw new Error(`Expected no rows, got ${rows.length}`);
    }
  }
}

/**
 * Base class for SQL-file-driven repositories.
 *
 * A subclass declares one {@link RepoQuery} field per query. At the end of
 * the constructor the subclass calls `this._autowire()`, which reads the
 * matching `.sql` file for each field (looking them up by field name in
 * `<dirname>/<sqlDir>/`) and injects the shared `Db` instance.
 *
 * The `_autowire()` call must live in the subclass constructor — not in
 * `super()` — because class-field initialisers only run after `super()`
 * returns.
 *
 * @example
 * ```ts
 * // books.repo.ts
 * import { Repo, RepoQuery, type Db } from '@moribashi/pg';
 * import type { Book } from './books.domain.js';
 *
 * export default class BooksRepo extends Repo {
 *   findAll = new RepoQuery<Book>();    // loads ./sql/findAll.sql
 *   findById = new RepoQuery<Book>();   // loads ./sql/findById.sql
 *
 *   constructor({ db }: { db: Db }) {
 *     super(import.meta.dirname, db);
 *     this._autowire();
 *   }
 * }
 * ```
 *
 * @experimental The Repo/RepoQuery pattern may evolve in a future release.
 */
export abstract class Repo {
  /**
   * @param dirname - The directory where the implementation is located
   *   (typically `import.meta.dirname` from the subclass).
   * @param db - The Db instance to inject into each RepoQuery.
   * @param sqlDir - The directory, relative to `dirname`, where the sql files
   *   are located. Defaults to `'sql'`.
   *
   * Subclasses must call `this._autowire()` at the end of their own constructor
   * (after class field initializers have run — calling it in `super()` is too early).
   */
  constructor(
    protected dirname: string,
    public db: Db,
    protected sqlDir = `sql`,
  ) {}

  /**
   * Populates every `RepoQuery` field on this repo with its matching `.sql`
   * file and a reference to `this.db`. Call at the end of the subclass
   * constructor.
   */
  protected _autowire() {
    const dir = path.join(this.dirname, this.sqlDir);
    autowireRepo(this, dir);
  }
}

/**
 * Scans `repo` for {@link RepoQuery} instance fields and populates each one
 * with `repo.db` and the contents of `<dir>/<fieldName>.sql`.
 *
 * Normally called transitively via {@link Repo._autowire}; exported for
 * advanced cases where you need to wire a non-`Repo` object.
 *
 * @param repo - The repo instance to wire up.
 * @param dir - Absolute path to the directory containing the SQL files.
 *
 * @experimental The Repo/RepoQuery pattern may evolve in a future release.
 */
export function autowireRepo(repo: Repo, dir: string) {
  for (const [key, prop] of Object.entries(repo)) {
    if (prop instanceof RepoQuery) {
      prop.db = repo.db;
      prop.sql = fs.readFileSync(path.join(dir, `${key}.sql`), 'utf8');
    }
  }
}
