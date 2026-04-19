# @moribashi/web

Fastify integration for Moribashi: HTTP server lifecycle and a fresh DI scope for every incoming request.

## Install

```sh
pnpm add @moribashi/web @moribashi/core fastify
```

Requires Node >= 24. `fastify` is a peer dependency.

## Quickstart

```ts
import { createApp } from '@moribashi/core';
import { webPlugin, WEB_REQUEST_SCOPE, type FastifyInstance } from '@moribashi/web';

class BooksService {
  findAll() {
    return [{ id: 1, title: 'Moby-Dick' }];
  }
}

const app = createApp();
app.use(webPlugin({ port: 3000 }));

// Services registered here get a fresh instance per HTTP request.
app.registerInScope(WEB_REQUEST_SCOPE, { booksService: BooksService });

const fastify = app.resolve<FastifyInstance>('fastify');
fastify.get('/books', async (request) => {
  const svc = request.scope.resolve<BooksService>('booksService');
  return svc.findAll();
});

await app.start(); // fastify.listen() fires here
// ... on shutdown:
await app.stop(); // fastify.close() fires here
```

Each request gets its own `request.scope` — an isolated Moribashi scope seeded with `request` and `reply`. Scoped services are disposed (their `onDestroy` hooks fire) when the response completes or the client aborts.

## API

See inline JSDoc on [`src/index.ts`](./src/index.ts).

Key exports:

- `webPlugin(options)` — Moribashi plugin wiring Fastify + per-request scopes
- `WEB_APP_SCOPE` — symbol key for app-level web scope (reserved)
- `WEB_REQUEST_SCOPE` — symbol key for per-request scope registrations
- `WebPluginOptions` — plugin config (`port`, `host`)
- `FastifyRequest.scope` — module augmentation exposing the per-request `MoribashiScope`

## Stability

`@public` API: `webPlugin`, `WEB_APP_SCOPE`, `WEB_REQUEST_SCOPE`, `WebPluginOptions`, and the `FastifyRequest.scope` augmentation.
