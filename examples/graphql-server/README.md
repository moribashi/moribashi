# @examples/graphql-server

Minimal Moribashi + Mercurius GraphQL server showing `bindResolvers` and
`scopeContext`. Resolvers read services off `this` (e.g. `this.greetService`),
and every GraphQL operation runs inside a fresh `WEB_REQUEST_SCOPE` so scoped
services get a new instance per request.

## Run it

```sh
pnpm install
pnpm --filter @examples/graphql-server run start
# then open http://localhost:3000/graphiql
```

## Try in GraphiQL

- `{ hello(name: "world") }` — returns `"Hello, world!"` via `this.greetService.hello`.
- `{ instanceId }` — run it twice; each call returns a different integer,
  proving `GreetService` is SCOPED under `WEB_REQUEST_SCOPE` (fresh instance
  per request).
