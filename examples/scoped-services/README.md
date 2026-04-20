# @examples/scoped-services

Minimal Fastify example that demonstrates Moribashi's named scopes and
per-request scoped services.

Every incoming HTTP request gets a fresh scope (keyed by
`WEB_REQUEST_SCOPE` / `Symbol.for('moribashi.scope.web.request')`) containing a
`RequestContext` service that generates a UUID on construction. The
`GET /whoami` handler reads it off `request.scope.cradle.requestContext` and
returns it in the response.

## Run it

```sh
pnpm install
pnpm --filter @examples/scoped-services run start
# in another shell:
curl http://localhost:3000/whoami
curl http://localhost:3000/whoami
```

Each call returns a distinct `requestId` — proof the scope (and its cached
`RequestContext`) is created and disposed per request, not shared globally.
