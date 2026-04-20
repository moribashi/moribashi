import type { Db } from '@moribashi/pg';
import { buildApp } from './app.js';

// --- App setup ---

const app = buildApp();

// --- Start (this is where `pgPlugin` runs `knex.migrate.latest`) ---

await app.start();

// --- Prove the schema works by counting the rows that V1.1.0 seeded. ---

const db = app.resolve<Db>('db');
const [row] = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM widgets');
console.log(`widgets table has ${row.count} rows`);

const widgets = await db.query<{ id: number; name: string }>(
  'SELECT id, name FROM widgets ORDER BY id',
);
for (const w of widgets) {
  console.log(`  #${w.id} ${w.name}`);
}

// --- Graceful shutdown ---

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.stop();
