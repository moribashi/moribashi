import { createApp } from '@moribashi/core';
import { flagsPlugin } from '@moribashi/flags';
import { graphqlPlugin } from '@moribashi/graphql';
import { pgPlugin } from '@moribashi/pg';
import { getFastify, webPlugin } from '@moribashi/web';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BooksService from './books/books.svc.js';
import { schema } from './graphql/schema.js';
import { resolvers } from './graphql/resolvers.js';
import debugRoutes from './misc/debug.router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- App setup ---

const app = createApp();

app.use(pgPlugin({
  host: 'postgres',
  user: 'moribashi',
  password: 'password',
  database: 'moribashi',
  migrationsDir: path.join(__dirname, '..', 'data', 'migrations'),
}));
app.use(webPlugin({ port: 3000 }));
app.use(graphqlPlugin({ schema, resolvers, graphiql: true }));
// Feature flags via OpenFeature. No provider configured → the bundled
// in-memory default, so the app has working flags with zero infrastructure.
// Swap for a real backend with `flagsPlugin({ ofrep: { baseUrl } })` or any
// `flagsPlugin({ provider })`. Registered after web so per-request evaluation
// context is wired.
app.use(flagsPlugin({
  flags: {
    'books.enriched-authors': {
      variants: { on: true, off: false },
      defaultVariant: 'off',
      disabled: false,
    },
  },
}));

await app.scan(['**/*.repo.ts', '**/*.svc.ts'], { cwd: __dirname });

// --- Routes ---

const fastify = getFastify(app);

debugRoutes(fastify);

fastify.get('/books', async (request) => {
  // Flag-gated behavior, evaluated with the per-request context (which carries
  // the principal's targetingKey when @moribashi/auth is registered).
  const enriched = await request.scope.cradle.flags.boolean('books.enriched-authors', false);
  if (enriched) {
    const booksService = request.scope.resolve<BooksService>('booksService');
    return booksService.findAllWithAuthors();
  }
  const booksRepo = request.scope.resolve<{ findAll(): Promise<unknown[]> }>('booksRepo');
  return booksRepo.findAll();
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
