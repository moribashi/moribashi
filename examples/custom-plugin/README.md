# @examples/custom-plugin

Shows how an end user authors their own Moribashi plugin.

## What to look at

- [`src/clock.plugin.ts`](./src/clock.plugin.ts) — the plugin itself: a `clockPlugin({ intervalMs })` factory that returns a `MoribashiPlugin`. Its `register(app)` hook stores the config as a value on the root container and registers a `ClockService` class. The service uses constructor injection (`constructor({ clockConfig })`), starts a `setInterval` in `onInit()`, and clears it in `onDestroy()`.
- [`src/app.ts`](./src/app.ts) — wires the plugin into a fresh `createApp()`.
- [`src/main.ts`](./src/main.ts) — boots the app and handles `SIGINT`/`SIGTERM`.
- [`src/__tests__/smoke.test.ts`](./src/__tests__/smoke.test.ts) — asserts `onInit` ran (ticks accumulate, "tick" is logged) and `onDestroy` ran (timer cleared, "stopped" logged).

## Anatomy of a plugin

```ts
import { asValue, type MoribashiPlugin } from '@moribashi/core';

export function clockPlugin(opts: { intervalMs: number }): MoribashiPlugin {
  return {
    name: '@examples/custom-plugin/clock',
    register(app) {
      app.container.register({ clockConfig: asValue(opts) });
      app.register({ clock: ClockService });
    },
  };
}
```

Key points:

- A plugin is just `{ name, register(app) }`. `register` may be async; the promise is awaited during `app.start()`.
- Use `app.register({ ... })` for class singletons (the most common case). Use `app.container.register({ key: asValue(...) })` for raw values like config.
- Services are duck-typed for lifecycle — any resolved singleton with an `onInit()` and/or `onDestroy()` method gets hooked in automatically.
- Dependencies are pulled via destructured constructor params (Awilix `PROXY` mode), so `ClockService` reads `clockConfig` from its cradle without any decorators or imports.

## Run it

```sh
pnpm --filter @examples/custom-plugin start
pnpm --filter @examples/custom-plugin test
```
