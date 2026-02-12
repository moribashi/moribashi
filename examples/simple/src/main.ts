import { createApp } from '@moribashi/core';
import { webPlugin } from '@moribashi/web';
import type { FastifyInstance } from '@moribashi/web';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BooksService from './books/books.svc.js';
import debugRoutes from './misc/debug.router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- App setup ---

const app = createApp();

app.use(webPlugin({ port: 3000 }));

await app.scan(['**/*.repo.ts', '**/*.svc.ts'], { cwd: __dirname });

// --- Routes ---

const fastify = app.resolve<FastifyInstance>('fastify');

debugRoutes(fastify);

fastify.get('/books', async (request) => {
  const booksService = request.scope.resolve<BooksService>('booksService');
  return booksService.findAllWithAuthors();
});

// --- Start ---

await app.start();

// Graceful shutdown
const shutdown = async () => {
  await app.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
