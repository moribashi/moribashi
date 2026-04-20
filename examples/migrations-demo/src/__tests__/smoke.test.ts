import { createKnex, type Db, type Knex } from '@moribashi/pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// Reuse the same pg config helper the rest of @moribashi/pg's integration tests
// use, so this smoke test runs in exactly the same CI Postgres job (ci.yml's
// `test` job sets `PGHOST=localhost` and starts a postgres service).
import { pgOpts } from '../../../../packages/pg/src/__tests__/pg-config.js';
import { buildApp } from '../app.js';

type App = ReturnType<typeof buildApp>;

let cleanupKnex: Knex;

/**
 * Wipe everything our migrations (and knex's tracking tables) touch so the
 * smoke test is repeatable — each run starts from an empty schema and
 * re-applies V1.0.0 + V1.1.0 from scratch.
 */
async function resetSchema() {
  await cleanupKnex.raw('DROP TABLE IF EXISTS widgets');
  await cleanupKnex.raw('DROP TABLE IF EXISTS knex_migrations');
  await cleanupKnex.raw('DROP TABLE IF EXISTS knex_migrations_lock');
}

beforeAll(async () => {
  cleanupKnex = createKnex(pgOpts);
});

afterAll(async () => {
  await cleanupKnex.destroy();
});

describe('examples/migrations-demo smoke test', () => {
  let app: App;

  beforeEach(async () => {
    await resetSchema();
    app = buildApp({ pg: pgOpts });
    await app.start();
  });

  afterEach(async () => {
    await app?.stop();
    await resetSchema();
  });

  it('runs both migrations on start() and seeds two widgets', async () => {
    const db = app.resolve<Db>('db');

    const widgets = await db.query<{ id: number; name: string }>(
      'SELECT id, name FROM widgets ORDER BY id',
    );

    expect(widgets).toHaveLength(2);
    expect(widgets.map((w) => w.name)).toEqual(['alpha', 'beta']);
  });

  it('records both migration versions in knex_migrations', async () => {
    const db = app.resolve<Db>('db');

    const rows = await db.query<{ name: string }>('SELECT name FROM knex_migrations ORDER BY name');

    expect(rows.map((r) => r.name)).toEqual([
      'V1.0.0__create_widgets.sql',
      'V1.1.0__seed_widgets.sql',
    ]);
  });
});
