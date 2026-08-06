# @moribashi/flags

Feature flags for [Moribashi](https://github.com/moribashi/moribashi) via
[OpenFeature](https://openfeature.dev) — the CNCF vendor-neutral flag-evaluation
standard.

- **Ships with a working default.** With no configuration you get OpenFeature's
  bundled in-memory provider, so an app always has flags with zero
  infrastructure — ideal for tests and local dev.
- **Standards-based by URL.** Point `ofrep: { baseUrl }` at any
  [OFREP](https://openfeature.dev/specification/appendix-c/)-compliant server
  (flagd, GO Feature Flag, Flipt, a homegrown service). No vendor SDK, no lock-in.
- **Fully pluggable.** Pass any OpenFeature `provider` for a vendor SDK or a
  custom implementation.
- **Per-request targeting for free.** When `@moribashi/web` (and optionally
  `@moribashi/auth`) are present, each request evaluates flags with a context
  derived from the principal — `targetingKey = principal.identity` — so per-user
  rollouts just work.

## Install

```sh
pnpm add @moribashi/flags
# only if you use the `ofrep` option:
pnpm add @openfeature/ofrep-provider
```

## Provider tiers

`flagsPlugin` resolves exactly one provider, in precedence order:

```ts
import { flagsPlugin } from '@moribashi/flags';

// 1. Full control — any OpenFeature provider (highest precedence)
app.use(flagsPlugin({ provider: myVendorProvider }));

// 2. Standards default — an OFREP server addressed by URL
app.use(flagsPlugin({ ofrep: { baseUrl: 'https://flags.internal', headers: { authorization: 'Bearer …' } } }));

// 3. Ships-by-default — in-memory, zero dependencies
app.use(flagsPlugin({
  flags: {
    'new-checkout': { variants: { on: true, off: false }, defaultVariant: 'off', disabled: false },
  },
}));

// …or nothing at all — still a working (empty) in-memory client
app.use(flagsPlugin());
```

## Evaluating flags

Register `flagsPlugin` **after** `webPlugin` (and after `authPlugin`, if used).
Inside a request, resolve `flags` from the request scope:

```ts
fastify.get('/checkout', async (request) => {
  const useNew = await request.scope.cradle.flags.boolean('new-checkout', false);
  return useNew ? newCheckout() : legacyCheckout();
});
```

In a GraphQL resolver (where `this` is the request cradle):

```ts
async price() {
  return (await this.flags.boolean('new-pricing', false)) ? newPrice() : oldPrice();
}
```

`Flags` exposes `boolean` / `string` / `number` / `object` plus `*Details`
variants (reason, variant, error metadata). All calls automatically carry the
per-request `evaluationContext`.

### Targeting

With `@moribashi/auth` registered, the evaluation context is derived from the
principal: `targetingKey = principal.identity`, plus `tid`/`type` when present.
Override the mapping with `contextFrom`:

```ts
app.use(flagsPlugin({ contextFrom: (p) => (p?.identity ? { targetingKey: p.identity, plan: 'pro' } : {}) }));
```

Without auth, evaluation uses an empty context and degrades cleanly — `flags` is
never a hard dependency on web or auth.

## Outside a web request (CLI, workers)

The package works with only the root client; evaluations use the empty/global
context:

```ts
const app = createApp();
app.use(flagsPlugin({ ofrep: { baseUrl: 'https://flags.internal' } }));
await app.start();
const flags = app.resolve('flags');
if (await flags.boolean('run-nightly-job', false)) { /* … */ }
```

## Lifecycle

The provider is set during `app.start()` via `setProviderAndWait`, so start
blocks until the provider is READY (the same gating as pg migrations). It's torn
down on `app.stop()`.
