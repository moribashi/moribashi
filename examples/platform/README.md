# examples/platform

A reference for the shape a team's own platform monorepo should take: a **gateway** composing a
handful of **core subgraphs** into one public graph. See
[`docs/federation-first-design.md`](../../docs/federation-first-design.md) for the design rationale.

```
examples/platform/
  gateway/     the composed public graph — gatewayPlugin()
  identity/    a core subgraph — graphqlPlugin({ federated: true })
  catalog/     a core subgraph — graphqlPlugin({ federated: true })
```

In your own project this folder becomes its own repo (or its own pnpm workspace) — the backbone
services your team owns directly, separate from the independently-owned team subgraphs that plug into
the same gateway later (see the "adding a new team subgraph" recipe in the docs).

Each package here is an ordinary Moribashi app: `webPlugin()` for the HTTP server, plus either
`graphqlPlugin({ federated: true })` (a subgraph) or `gatewayPlugin()` (the composer). Nothing about
running them is different from `examples/simple` — they're separate processes that happen to know how
to find each other.

## Run it

Three terminals, in this order (subgraphs before the gateway, so it has something to discover on first
boot):

```sh
pnpm --filter @moribashi/example-platform-identity start   # :4001
pnpm --filter @moribashi/example-platform-catalog start    # :4002
pnpm --filter @moribashi/example-platform-gateway start    # :4000
```

Then query the composed supergraph:

```sh
curl -s localhost:4000/graphql -H 'content-type: application/json' \
  --data '{"query":"{ users { name } products { name price } }"}'
```

Or open GraphiQL at `http://localhost:4000/graphiql` — one schema, two teams' worth of fields.

Each subgraph is also independently queryable on its own port (`http://localhost:4001/graphql`,
`http://localhost:4002/graphql`) — a federated service is still a complete, valid GraphQL server on its
own; the gateway is additive, not required for local development of a single subgraph.
