# @moribashi/auth

Authentication as a standard moribashi plugin: bearer-token validation against
one or more OIDC issuers, a typed `Principal` in the request DI scope, a small
enforcement API (`SecurityService`), and optional workload identity for
services on Kubernetes.

Validation is **resource-server style** — issuer metadata and JWKS only, no
client credentials required. Apps that need to *hold* an identity (for
service-to-service calls) use the optional workload-identity client.

## Quickstart

```ts
import { createApp } from '@moribashi/core';
import { webPlugin } from '@moribashi/web';
import { authPlugin } from '@moribashi/auth';

const app = createApp();

app.use(webPlugin({ port: 3000 }));

// After webPlugin — same ordering rule as graphqlPlugin.
app.use(authPlugin({
  issuers: [
    {
      issuer: 'https://idp.example.com/realms/main', // OIDC discovery root
      audience: 'my-platform',
      tid: 1,                                        // app-assigned issuer id
    },
  ],
  claims: 'app', // namespace of the identity claim block
}));

await app.start();
```

Every request now carries `principal` and `securityService` in its DI scope,
alongside `request`/`reply` from `@moribashi/web`. GraphQL resolvers (whose
`this` is the request cradle) can enforce directly:

```ts
const resolvers: ResolverMap<AuthCradle> = {
  Query: {
    me() {
      return this.securityService.ensureAuthenticated().identity;
    },
  },
};
```

### The identity claim block

The plugin reads a namespaced object from the verified payload:

```json
{ "app": { "identity": "user-1", "audit": "user-1", "type": "USER" } }
```

`identity` and `audit` are required; a token that verifies cryptographically
but lacks them is an *invalid token*, not an anonymous caller. The block may
also carry `permissions: string[]` for `hasGlobal` checks.

For issuers that don't mint the block (e.g. a Kubernetes cluster), pass a
mapper instead of a namespace:

```ts
authPlugin({
  issuers: [...],
  claims: (payload, issuer) =>
    issuer.tid === 2
      ? { identity: payload.sub!, type: 'SERVICE' }        // k8s SA token
      : (payload.app as { identity: string; audit: string; type: string }),
});
```

### Errors are captured, not thrown

The `onRequest` hook **never rejects a request**:

- No `Authorization` header → `AnonymousPrincipal.INSTANCE`; the request proceeds.
- Header present but the token is invalid/expired/wrong-audience/unlisted-issuer
  → the principal is anonymous **and** a typed `AuthError` is captured into the
  request scope. It surfaces when the app calls an `ensure*` method, preserving
  the true cause.

This matters for GraphQL: one operation can touch public and protected fields;
public fields resolve, protected fields fail with `SessionExpiredError` rather
than a generic "not authenticated".

Taxonomy: `AuthError` → `NotAuthenticatedError`, `SessionExpiredError`,
`InvalidTokenError`, `NotAuthorizedError` (→ `MissingPermissionError`).

### SecurityService

```ts
const user = securityService.ensureAuthenticated(); // narrows to TokenPrincipal
securityService.hasGlobal('admin');                 // from token claims

// Context-scoped authorization (org / project / tenant …)
const ctx = securityService.withContext(orgId);
await ctx.hasAny('books:write');
await ctx.hasRole('editor');
await ctx.ensureAny('books:write');                 // throws MissingPermissionError
```

Context-scoped access is deliberately **not** read from the token (it changes
without re-login and bloats tokens). Register an `AccessLoader` and the
service fetches through it behind a short-TTL cache (default 60s, configurable
via `accessCacheTtlMs`), keyed by `identity:contextId`:

```ts
import { asValue } from '@moribashi/core';

app.container.register({
  accessLoader: asValue({
    async load(identity, contextId) {
      return db.loadAccess(identity, contextId); // { roles, permissions }
    },
  }),
});
```

Without an `AccessLoader`, `withContext()` throws a configuration error at
call time; `ensureAuthenticated`/`hasGlobal` work standalone.

## Kubernetes workload identity

### Inbound: trusting a cluster

Nothing special — a cluster is just another `issuers[]` entry. Kubernetes API
servers expose OIDC discovery and JWKS for ServiceAccount tokens; pods
authenticate to peers with projected ServiceAccount tokens:

```yaml
volumes:
  - name: peer-token
    projected:
      sources:
        - serviceAccountToken:
            path: token
            audience: my-platform   # becomes the aud claim
            expirationSeconds: 3600
```

```ts
authPlugin({
  issuers: [
    { issuer: 'https://idp.example.com/realms/main', audience: 'my-platform', tid: 1 },
    { issuer: 'https://oidc.eks.example.amazonaws.com/id/ABC123', audience: 'my-platform', tid: 2 },
  ],
  claims: (payload, issuer) =>
    issuer.tid === 2 ? { identity: payload.sub!, type: 'SERVICE' } : /* … */,
});
```

### Outbound: token exchange (RFC 8693)

For services that must present an IdP-issued token rather than a raw
ServiceAccount token:

```ts
import { workloadIdentityPlugin, type ServiceToken } from '@moribashi/auth';

app.use(workloadIdentityPlugin({
  tokenEndpoint: 'https://idp.example.com/realms/main/protocol/openid-connect/token',
  subjectTokenPath: '/var/run/secrets/tokens/idp', // projected SA token file
  audience: 'my-platform',
}));

// anywhere in the container:
const token = await serviceToken.get();
fetch(peerUrl, { headers: { authorization: `Bearer ${token}` } });
```

The plugin registers a singleton `serviceToken` provider that exchanges the
pod's projected ServiceAccount token for an IdP access token, refreshing ahead
of expiry and re-reading the projected file on each exchange (the kubelet
rotates it). No secrets in the deployment — the ServiceAccount *is* the
credential.

Requirements on the IdP side:

- The IdP must **trust the cluster's OIDC issuer** (external-to-internal token
  exchange). In Keycloak this is an identity provider + token-exchange policy;
  other IdPs have equivalents.
- The exchange is `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`
  with the SA token as `subject_token`. Pass `clientId` if your IdP requires a
  public client for the exchange.

## Testing your app

Issuer entries accept a static `jwks` (a `JSONWebKeySet`) instead of network
discovery, so tests can sign tokens with a local key and verify fully offline
— see this package's test suite for a working pattern.

## Non-goals (for now)

Session/cookie auth, opaque-token introspection (RFC 7662 — the config shape
leaves room for it), impersonation semantics (the claim shape reserves space:
`audit` vs `identity`), and GraphQL schema directives (apps enforce in
resolvers/services).
