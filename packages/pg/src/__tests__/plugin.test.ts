import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createApp } from '@moribashi/core';
import { pgPlugin, Db, createKnex } from '../index.js';
import type { Knex } from 'knex';
import { pgOpts, connectionString } from './pg-config.js';


let app: ReturnType<typeof createApp>;

afterEach(async () => {
  await app?.stop();
});

describe('pgPlugin', () => {
  it('registers knex on the root container', async () => {
    app = createApp();
    app.use(pgPlugin(pgOpts));
    await app.start();

    const knex = app.resolve<Knex>('knex');
    expect(knex).toBeDefined();

    const result = await knex.raw('SELECT 1 AS val');
    expect(result.rows).toEqual([{ val: 1 }]);
  });

  it('registers db on the root container', async () => {
    app = createApp();
    app.use(pgPlugin(pgOpts));
    await app.start();

    const db = app.resolve<Db>('db');
    expect(db).toBeInstanceOf(Db);
  });

  it('db.query works against real Postgres', async () => {
    app = createApp();
    app.use(pgPlugin(pgOpts));
    await app.start();

    const db = app.resolve<Db>('db');
    const rows = await db.query<{ greeting: string }>(
      "SELECT 'hello ' || :name AS greeting",
      { name: 'world' },
    );
    expect(rows).toEqual([{ greeting: 'hello world' }]);
  });

  it('db.knex is the same instance as the registered knex', async () => {
    app = createApp();
    app.use(pgPlugin(pgOpts));
    await app.start();

    const knex = app.resolve<Knex>('knex');
    const db = app.resolve<Db>('db');
    expect(db.knex).toBe(knex);
  });

  it('cleans up the connection pool on app.stop() via knex disposer', async () => {
    app = createApp();
    app.use(pgPlugin(pgOpts));
    await app.start();

    const db = app.resolve<Db>('db');
    const knex = db.knex;

    await app.stop();

    // After destroy, querying should fail
    await expect(knex.raw('SELECT 1')).rejects.toThrow();
  });

  it('supports connectionString config', async () => {
    app = createApp();
    app.use(pgPlugin({ connectionString }));
    await app.start();

    const db = app.resolve<Db>('db');
    const rows = await db.query<{ db: string }>('SELECT current_database() AS db');
    expect(rows).toEqual([{ db: 'moribashi' }]);
  });

  describe('migrationsDir', () => {
    let tmpDir: string;
    let cleanupKnex: Knex;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-plugin-mig-'));
      cleanupKnex = createKnex(pgOpts);
      // ensure clean state — drop any leftover migration tracking tables
      await cleanupKnex.raw('DROP TABLE IF EXISTS plugin_mig_test');
      await cleanupKnex.raw('DROP TABLE IF EXISTS knex_migrations');
      await cleanupKnex.raw('DROP TABLE IF EXISTS knex_migrations_lock');
    });

    afterEach(async () => {
      await cleanupKnex.raw('DROP TABLE IF EXISTS plugin_mig_test');
      await cleanupKnex.raw('DROP TABLE IF EXISTS knex_migrations');
      await cleanupKnex.raw('DROP TABLE IF EXISTS knex_migrations_lock');
      await cleanupKnex.destroy();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('runs migrations on startup when migrationsDir is provided', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'V1.0.0__create_test.sql'),
        'CREATE TABLE plugin_mig_test (id SERIAL PRIMARY KEY, label TEXT NOT NULL);',
      );

      app = createApp();
      app.use(pgPlugin({ ...pgOpts, migrationsDir: tmpDir }));
      await app.start();

      const db = app.resolve<Db>('db');
      await db.query("INSERT INTO plugin_mig_test (label) VALUES (:label)", { label: 'works' });
      const rows = await db.query<{ label: string }>('SELECT label FROM plugin_mig_test');
      expect(rows).toEqual([{ label: 'works' }]);
    });
  });
});
