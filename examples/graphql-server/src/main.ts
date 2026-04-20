import { buildApp } from './app.js';

const app = await buildApp();

await app.start();

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
