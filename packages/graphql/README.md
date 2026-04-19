# @moribashi/graphql

Mercurius integration for Moribashi: resolvers run in per-request DI scopes and resolve services via `this`.

## Install

```sh
pnpm add @moribashi/graphql @moribashi/core @moribashi/web fastify mercurius
```

`fastify` and `mercurius` are peer dependencies.

## Quickstart

```ts
import { createApp } from '@moribashi/core';
import { graphqlPlugin, type ResolverMap } from '@moribashi/graphql';
import { webPlugin } from '@moribashi/web';
import type BooksService from './books/books.svc.js';

interface RequestCradle {
  booksService: BooksService;
}

const schema = `
  type Book { id: Int!, title: String! }
  type Query { books: [Book!]! }
`;

const resolvers: ResolverMap<RequestCradle> = {
  Query: {
    async books(this: RequestCradle) {
      return this.booksService.findAll();
    },
  },
};

const app = createApp();
app.use(webPlugin({ port: 3000 }));
app.use(graphqlPlugin({ schema, resolvers, graphiql: true }));
await app.start();
```

`@moribashi/web` must be registered before `graphqlPlugin` — each HTTP request gets its own Moribashi scope, and resolvers see it as `this`.

## API

See inline JSDoc on [`src/index.ts`](./src/index.ts).

Key exports:

- `graphqlPlugin(options)` — Moribashi plugin that registers Mercurius with scoped resolvers
- `bindResolvers(resolvers)` — wraps resolvers so `this` is the request scope cradle
- `scopeContext(request)` — Mercurius context factory exposing the request scope
- `GraphQLPluginOptions` — options for `graphqlPlugin`
- `ResolverMap<Cradle>` / `BoundResolver<Cradle>` — typed resolver shape
- `GRAPHQL_SCOPE` — scope symbol for GraphQL requests

## Stability

`@public`: `graphqlPlugin`, `bindResolvers`, `scopeContext`, `GraphQLPluginOptions`, `ResolverMap`, `BoundResolver`, `GRAPHQL_SCOPE`.
