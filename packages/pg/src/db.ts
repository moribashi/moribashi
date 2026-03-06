import type { Knex } from 'knex';
import camelcaseKeys, { type Options as CamelCaseOptions } from 'camelcase-keys';

/**
 * Thin wrapper around a Knex instance that provides a `query()` helper
 * returning camelCase'd rows. Registered as a singleton by `pgPlugin`.
 *
 * Connection pool lifecycle is managed by the knex registration's disposer.
 */
export class Db {
  constructor(public knex: Knex) {}

  /** Run a raw SQL query with named params, returning camelCase'd rows. */
  async query<T extends object>(
    sql: string,
    params?: Record<string, unknown>,
    camelCaseOpts?: CamelCaseOptions,
  ): Promise<T[]> {
    const { rows } = (await this.knex.raw(sql, params ?? {})) as { rows: T[] };
    return rows.map((r) => camelcaseKeys<T>(r, { deep: true, ...camelCaseOpts }) as T);
  }
}
