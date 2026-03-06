import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createKnex, type Knex, Db } from '../index.js';
import { pgOpts } from './pg-config.js';

let knex: Knex;
let db: Db;

beforeAll(async () => {
  knex = createKnex(pgOpts);
  db = new Db(knex);
});

afterAll(async () => {
  await knex.destroy();
});

describe('Db', () => {
  it('runs a raw query and returns rows', async () => {
    const rows = await db.query<{ val: number }>('SELECT 1 AS val');
    expect(rows).toEqual([{ val: 1 }]);
  });

  it('supports named params', async () => {
    const rows = await db.query<{ greeting: string }>(
      "SELECT 'hello ' || :name AS greeting",
      { name: 'Heisenberg' },
    );
    expect(rows).toEqual([{ greeting: 'hello Heisenberg' }]);
  });

  it('camelCases column names by default', async () => {
    const rows = await db.query<{ myValue: number }>(
      'SELECT 42 AS my_value',
    );
    expect(rows).toEqual([{ myValue: 42 }]);
  });

  it('camelCases nested keys with deep: true', async () => {
    const rows = await db.query<{ result: { nestedKey: number } }>(
      `SELECT json_build_object('nested_key', 1) AS result`,
    );
    expect(rows[0].result).toEqual({ nestedKey: 1 });
  });

  it('returns empty array for no rows', async () => {
    await knex.schema.createTable('db_empty_test', (t) => {
      t.increments('id');
    });
    try {
      const rows = await db.query('SELECT * FROM db_empty_test');
      expect(rows).toEqual([]);
    } finally {
      await knex.schema.dropTableIfExists('db_empty_test');
    }
  });

  it('returns multiple rows in order', async () => {
    const rows = await db.query<{ n: number }>(
      'SELECT generate_series(1, 3) AS n',
    );
    expect(rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});
