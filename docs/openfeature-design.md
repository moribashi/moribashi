# OpenFeature / OFREP integration design

**Status:** proposal / analysis
**Package:** `@moribashi/flags` (new)
**Depends on:** `common`, `core`; optional soft-integration with `web` + `auth`

## TL;DR — the recommendation

Ship a new leaf package `@moribashi/flags` that wraps the CNCF
[OpenFeature](https://openfeature.dev) server SDK. It maps onto Moribashi's
existing machinery almost 1:1:

- **A root singleton** holds the OpenFeature client. The provider is set at
  plugin registration; the framework's own lifecycle (`onInit`/`onDestroy`)
  drives provider `initialize()` / `close()`. No new lifecycle concepts.
- **The provider is the one pluggable knob.** `flagsPlugin()` ships a working
  default (in-memory provider, zero external deps at runtime), accepts an
  `ofrep: { baseUrl }` shorthand for the standard remote protocol, and accepts
  any `provider: Provider` for full control. Precedence:
  `provider` > `ofrep` > in-memory default.
- **A request-scoped evaluation context** is enriched from the auth principal
  via an `onRequest` hook — the exact same pattern `@moribashi/auth` already
  uses. Flags evaluate with `targetingKey = principal.identity` for free when
  auth is present, and degrade to the anonymous/empty context when it isn't.

This gives "a standard that ships by default, but a provider that's trivially
swappable" — the bonus goal — because OpenFeature's own `Provider` interface
*is* the seam, and OFREP is just the provider you get by passing a URL.

## Why OpenFeature is a clean fit for Moribashi

OpenFeature is a vendor-neutral flag-evaluation API. Two facts make it ideal
here:

1. **The `Provider` interface is the vendor seam.** Application code only ever
   touches `OpenFeature.getClient()` and `client.getBooleanValue(...)`. Swapping
   LaunchDarkly → flagd → a self-hosted OFREP server → an in-memory test double
   is a one-line provider change and *nothing in app code moves*. That is
   exactly the "pluggable if desired" property, and OpenFeature already owns it —
   we don't design it, we expose it.

2. **OFREP (OpenFeature Remote Evaluation Protocol) is a REST contract, not a
   vendor.** An OFREP provider is configured with just a base URL
   (`POST {baseUrl}/ofrep/v1/evaluate/flags/{key}`). So "the standard that ships
   by default" can be *purely a URL* — no vendor SDK, no credentials model,
   works against flagd, GO Feature Flag, Flipt, Unleash-via-edge, or a homegrown
   server. That's the strongest possible default: standards-based and
   dependency-light.

The lifecycle also lines up. OpenFeature providers have optional
`initialize(context)` and `onClose()` methods and emit readiness/error events.
Moribashi already has a container that eagerly resolves singletons and fires
`onInit` on start, then `onDestroy` in reverse on stop. We wrap the provider set
+ init in `onInit` and the close in `onDestroy`. No polling, no ad-hoc "is the
flag client ready?" checks in app code — `app.start()` doesn't resolve until the
provider is ready, identical to how `pgPlugin` runs migrations before start
completes and `webServer` binds the port in `onInit`.

## How it maps onto the framework

| OpenFeature concept | Moribashi mechanism | Precedent in repo |
|---|---|---|
| `OpenFeature` global API / client | root singleton `featureClient` | `db`, `fastify` |
| provider `initialize()` / `onClose()` | `onInit` / `onDestroy` on a lifecycle service | `WebServer`, `Db` |
| per-request `EvaluationContext` | request-scope value set in `onRequest` | `@moribashi/auth` principal |
| `targetingKey` = who is asking | `principal.identity` from auth | `authPlugin` cradle merge |
| provider swap | `flagsPlugin({ provider })` option | `authPlugin({ issuers })` options |

## Package shape

```
packages/flags/
  src/
    index.ts        # public surface: flagsPlugin, types, Flags service, re-exports
    plugin.ts       # flagsPlugin() factory + lifecycle service + request hook
    config.ts       # FlagsPluginOptions, provider precedence resolution
    context.ts      # buildEvaluationContext(principal?) helper
  package.json
  tsup.config.ts
  tsconfig.json
```

Dependency order stays legal: `common → core → {web} → flags`. Like `auth`,
`web` is a *soft* dependency — the request-scope enrichment is only wired when a
Fastify instance is present in the container; a CLI/worker app uses the same
package with only the root client.

### 1. The root client + lifecycle service

```ts
// plugin.ts (sketch)
import { OpenFeature, type Client, type Provider, type EvaluationContext } from '@openfeature/server-sdk';
import { asValue, asClass, Lifetime, type MoribashiApp, type MoribashiPlugin } from '@moribashi/core';
import type { OnInit, OnDestroy } from '@moribashi/common';
import { resolveProvider, type FlagsPluginOptions } from './config.js';

export interface FlagsCradle {
  /** Domain-bound OpenFeature client, shared process-wide. */
  featureClient: Client;
  /** Thin, request-context-aware wrapper (see below). */
  flags: Flags;
}

class FeatureProviderLifecycle implements OnInit, OnDestroy {
  constructor(private readonly provider: Provider, private readonly domain?: string) {}
  async onInit() {
    // Resolves only when the provider reports READY (or throws on fatal error),
    // so app.start() gates on flags being live — same contract as pg migrations.
    await OpenFeature.setProviderAndWait(...(this.domain ? [this.domain] : []), this.provider);
  }
  async onDestroy() {
    await OpenFeature.close(); // closes all providers; flushes vendor SDKs
  }
}

export function flagsPlugin(opts: FlagsPluginOptions = {}): MoribashiPlugin {
  return {
    name: '@moribashi/flags',
    register(app: MoribashiApp) {
      const provider = resolveProvider(opts);           // <-- the pluggability seam
      const domain = opts.domain;
      const client = domain ? OpenFeature.getClient(domain) : OpenFeature.getClient();

      app.container.register({
        featureProviderLifecycle: asClass(FeatureProviderLifecycle)
          .inject(() => ({ provider, domain }))
          .setLifetime(Lifetime.SINGLETON),
        featureClient: asValue(client),
        flags: asClass(Flags).setLifetime(Lifetime.SCOPED), // request-aware; see §3
      });

      wireRequestContext(app, opts); // no-op if @moribashi/web absent
    },
  };
}
```

Note `featureClient` is a root `asValue` (the OpenFeature client is inherently a
singleton keyed by domain), while `flags` is `SCOPED` so it can pick up the
per-request evaluation context. In a non-web app, the scoped `flags` simply
resolves against the root and uses the global/empty context.

### 2. Provider pluggability — "ships by default, swap if desired"

All the "default vs standard vs custom" logic lives in one pure function so the
precedence is obvious and testable:

```ts
// config.ts (sketch)
export interface FlagsPluginOptions {
  /** Full control: any OpenFeature Provider. Highest precedence. */
  provider?: Provider;
  /** Standards default: point at any OFREP-compliant server by URL. */
  ofrep?: { baseUrl: string; headers?: Record<string, string> };
  /** Zero-dep fallback default: static flags, great for tests/local/dev. */
  flags?: InMemoryFlagConfig;
  /** OpenFeature domain for multi-provider setups. Optional. */
  domain?: string;
  /** Map the auth principal into the evaluation context. Default: identity → targetingKey. */
  contextFrom?: (principal: Principal | undefined) => EvaluationContext;
}

export function resolveProvider(opts: FlagsPluginOptions): Provider {
  if (opts.provider) return opts.provider;                       // 1. explicit
  if (opts.ofrep)    return new OFREPProvider(opts.ofrep);       // 2. standard-by-URL
  return new InMemoryProvider(opts.flags ?? {});                 // 3. ships-by-default
}
```

The three tiers, from most-batteries-included to most-control:

- **Nothing configured** → `InMemoryProvider`. The framework boots, flags
  resolve to their defaults, tests and local dev work with zero infrastructure.
  This is the "ships by default" guarantee: a Moribashi app *always* has a
  working flag client.
- **`ofrep: { baseUrl }`** → the OFREP provider. This is the recommended
  production default: a real remote flag service via the open standard, no vendor
  lock-in, configured with a URL and optional auth headers.
- **`provider: myProvider`** → any OpenFeature provider (flagd, LaunchDarkly,
  Split, Flagsmith, GO Feature Flag native, a custom one). Full escape hatch.

Packaging choice that keeps this honest: `@openfeature/server-sdk` is a **direct
dependency** (it defines `Provider`/`Client` — our public types), the in-memory
provider ships **bundled** (it's the default, must always be present), and the
OFREP provider is an **optional peer dependency** — imported lazily inside
`resolveProvider` only when `opts.ofrep` is set, so apps that pass their own
provider never pull it. Same discipline as `graphql`'s `fastify` peer.

### 3. Request-scoped evaluation context (auth integration)

This is a carbon copy of the `@moribashi/auth` hook. After `webPlugin` has
created `request.scope`, a `onRequest` hook derives the evaluation context from
whatever principal is present and stashes it on the scope:

```ts
// wireRequestContext (sketch)
fastify.addHook('onRequest', async (request) => {
  const principal = safeResolve(request.scope, 'principal'); // present iff @moribashi/auth ran
  const evaluationContext = (opts.contextFrom ?? defaultContextFrom)(principal);
  request.scope.container.register({ evaluationContext: asValue(evaluationContext) });
});

const defaultContextFrom = (p?: Principal): EvaluationContext =>
  p && 'identity' in p ? { targetingKey: p.identity, /* tid, type, ... */ } : {};
```

And the scoped `Flags` service reads it, so app/resolver code stays clean:

```ts
class Flags {
  constructor(private d: { featureClient: Client; evaluationContext?: EvaluationContext }) {}
  boolean(key: string, def: boolean)  { return this.d.featureClient.getBooleanValue(key, def, this.d.evaluationContext); }
  string(key: string, def: string)    { return this.d.featureClient.getStringValue(key, def, this.d.evaluationContext); }
  number(key: string, def: number)    { return this.d.featureClient.getNumberValue(key, def, this.d.evaluationContext); }
  object<T>(key: string, def: T)      { return this.d.featureClient.getObjectValue<T>(key, def, this.d.evaluationContext); }
  // *Details variants for reason/variant/error metadata
}
```

Cradle augmentation makes this discoverable, mirroring how `auth` merges into
`WebRequestCradle`:

```ts
declare module '@moribashi/web' {
  interface WebRequestCradle {
    evaluationContext: EvaluationContext;
    flags: Flags;
  }
}
```

Usage in a route or GraphQL resolver (where `this` is the cradle) becomes:

```ts
if (await request.scope.cradle.flags.boolean('new-checkout', false)) { ... }
// resolver:
async someField() { return this.flags.boolean('new-pricing', false) ? ... : ...; }
```

Because targeting flows from the auth principal automatically, per-user rollouts
"just work" the moment both plugins are registered — and there is no hard
dependency: `flags` on its own evaluates against an empty context.

## Alternatives considered

- **OpenFeature transaction-context propagation (AsyncLocalStorage).**
  OpenFeature can pull per-request context from an ALS-backed transaction
  propagator, avoiding threading context through the client call. It's elegant
  but it introduces a *second*, global, implicit request-context mechanism that
  competes with Moribashi's explicit DI scopes. Rejected as the default for
  consistency; can be offered later as `flagsPlugin({ propagation: 'als' })` for
  users who want context to reach flag calls made deep in code that doesn't have
  the scope in hand.

- **Fold flags into `@moribashi/core`.** Tempting for "in the core," but core has
  zero third-party deps beyond awilix and is the base of the dependency graph.
  Adding an OpenFeature dep there taxes every consumer (CLI tools, workers) with
  flag machinery they may not want. A leaf package that *feels* core (one
  `app.use(flagsPlugin())` line, ships a working default) achieves the goal
  without the coupling — same philosophy as `web`/`pg`/`auth` being separate.

- **Bundle a vendor SDK as the default.** Rejected: picks a winner, adds a heavy
  dep, and contradicts OpenFeature's whole point. In-memory (dep-free) as the
  fallback and OFREP (standard, URL-configured) as the recommended production
  default is strictly better.

## Open questions / follow-ups

1. **Global-flag vs domain-bound client.** Default to the unnamed global client;
   expose `domain` for apps running multiple providers. Low cost to support both
   now.
2. **Static hooks & logging.** OpenFeature hooks (logging, metrics, telemetry)
   are a natural place to bridge into whatever `@moribashi` logging/otel story
   exists or emerges. Out of scope for v1; leave `hooks?: Hook[]` passthrough in
   options.
3. **Events / dynamic reconfiguration.** Providers emit `PROVIDER_READY`,
   `PROVIDER_ERROR`, `PROVIDER_CONFIGURATION_CHANGED`. v1 can ignore these
   beyond gating start on ready; a later iteration could surface them via a
   lifecycle event bus if one lands in core.
4. **Version pinning.** ✅ Resolved during implementation:
   `@openfeature/server-sdk@^1.23.0` (direct dep) — and note `InMemoryProvider`
   ships *inside* it, so the default provider needs no separate package and is
   truly dep-free. The OFREP **server** provider is
   `@openfeature/ofrep-provider@^0.2.5` (`new OFREPProvider({ baseUrl, headers:
   [[k,v]][], timeoutMs })`), carried as an optional peer. Teardown is
   `OpenFeature.clearProviders()`.

## Suggested implementation path

1. Scaffold `packages/flags` from `packages/auth` (same tsup/tsconfig/package
   layout, leaf-package conventions).
2. Land the root client + `FeatureProviderLifecycle` + in-memory default first —
   fully usable, no web/auth needed, testable with `InMemoryProvider`.
3. Add `resolveProvider` precedence + lazy OFREP import.
4. Add the `onRequest` context hook and `Flags` scoped service + `WebRequestCradle`
   augmentation; wire auth targeting.
5. Extend `examples/simple` with a flag-gated route/resolver to exercise the
   auth → targeting path end-to-end.
6. Record the decision in `.agents/state/decisions.md`.
```
