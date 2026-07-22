# REST + OpenAPI from the GraphQL schema (sofa-api)

Status: proposed in [#12](https://github.com/moribashi/moribashi/issues/12), prototype working end-to-end.

## What

`graphqlPlugin({ rest: true })` additionally exposes every query/mutation as a
REST endpoint, with an always-in-sync OpenAPI 3 spec and Swagger UI:

| Surface       | Default location            |
|---------------|-----------------------------|
| REST routes   | `/api/...` (e.g. `GET /api/books`, `GET /api/book/:id`, `POST /api/add-book`) |
| OpenAPI spec  | `/api/openapi.json`         |
| Swagger UI    | `/api/docs`                 |

`rest` also accepts a `RestOptions` object: `basePath`, `openApi` (title /
description / version / endpoint), `swaggerUi` (or `false`), `depthLimit`,
`ignore`, and per-operation `routes` overrides — all passed through to
[sofa-api](https://the-guild.dev/graphql/sofa-api).

## How it works

- sofa-api v0.18 (`useSofa`) returns a [fets](https://the-guild.dev/openapi/fets)
  router — a whatwg-node server adapter. fets natively serves the OpenAPI JSON
  and Swagger UI, so we get docs for free.
- We reuse the executable schema Mercurius built (`fastify.graphql.schema`),
  registered as a Fastify plugin *after* Mercurius so it's available. REST and
  GraphQL therefore share resolvers and can never drift.
- REST requests route through the same Fastify instance via a
  `${basePath}/*` wildcard, so `@moribashi/web`'s `onRequest` hook gives them
  the same per-request DI scope as GraphQL — `this.someService` in a resolver
  works identically over REST. Sofa's `context` is our existing `scopeContext`.

## Gotchas encountered (already handled)

1. **Body parsing**: Fastify parses JSON bodies, consuming the raw stream.
   whatwg-node's pre-parsed-body shim proxies `.json()`/`.text()` but leaves
   `Request.body` null, and sofa gates on `request.body != null` — so POST
   variables silently vanished. Fix: inside the (encapsulated) sofa plugin
   context, replace the content-type parsers with a passthrough that hands the
   raw stream to sofa. Only affects the `${basePath}/*` routes.
2. **Unmatched routes**: fets returns `undefined` for unmatched paths; we fall
   back to `reply.callNotFound()` so `/api/nope` is a clean Fastify 404.

## Default-on vs opt-in

Recommended: **opt-in flag on `graphqlPlugin`** (implemented), not default-on:

- Default-on would silently widen every service's HTTP surface (auth policies
  written for `/graphql` wouldn't cover `/api/*`).
- sofa-api brings ~44 transitive packages (fets, @whatwg-node/*, qs, ...) into
  `@moribashi/graphql`'s dependency tree. Acceptable as a direct dep; if we
  want to keep the base install lean it could become an optional peer dep +
  dynamic `import()` inside `mountRest` (register callback is already async).
  A separate `@moribashi/rest` package felt like overkill for ~90 lines.

## Not yet covered

- `federated: true` + `rest` — should work (the federation plugin also
  decorates `fastify.graphql`), but untested.
- Subscriptions→webhooks (sofa supports it; out of scope).
- Mercurius loaders/JIT don't apply to REST calls — sofa executes with plain
  `graphql-js` `execute` against the same schema. Fine for correctness; a
  future optimization could pass sofa an `execute` that delegates to
  Mercurius.

## Verification

`examples/simple/src/rest-smoke.ts` (in-memory services, no postgres):
GraphQL + REST list/by-id/mutation + OpenAPI info override + custom basePath +
Swagger UI on/off + bad-JSON 400 + unknown-route 404 all verified by curl.
