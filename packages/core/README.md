# @moribashi/core

Lightweight TypeScript DI container for Node — a thin, convention-driven layer over [Awilix](https://github.com/jeffijoe/awilix) with composable scopes, duck-typed lifecycle hooks (`onInit` / `onDestroy`), and a minimal plugin system.

## Install

```sh
pnpm add @moribashi/core
```

Requires Node >= 24.

## Quickstart

```ts
import { createApp } from '@moribashi/core';
import type { OnInit, OnDestroy } from '@moribashi/common';

class GreeterService implements OnInit, OnDestroy {
  onInit() {
    console.log('[Greeter] ready');
  }
  greet(name: string) {
    return `hello, ${name}`;
  }
  async onDestroy() {
    console.log('[Greeter] shutting down');
  }
}

const app = createApp();
app.register({ greeterService: GreeterService });

await app.start(); // eagerly resolves singletons, fires onInit

const greeter = app.resolve<GreeterService>('greeterService');
console.log(greeter.greet('world'));

await app.stop(); // disposes scopes, fires onDestroy in reverse order
```

See [`examples/simple`](../../examples/simple) for a full Postgres + GraphQL + Fastify wiring.

## API

See inline JSDoc on [`src/index.ts`](./src/index.ts), or generate TypeDoc from the repo root.

Key exports:
- `createApp()` — create a new app/container
- `MoribashiApp` — the app handle
- `MoribashiScope` — per-request/per-event scope
- `MoribashiPlugin` — plugin interface
- `ScanOptions` — module auto-scan options

Re-exports from Awilix (`asClass`, `asFunction`, `asValue`, `Lifetime`, `AwilixContainer`) are provided for plugin authors who need to register non-class resolvers on `app.container`.

## Stability

`@public` API: `createApp`, `MoribashiApp`, `MoribashiScope`, `MoribashiPlugin`.
`@experimental`: `ScanOptions` and `MoribashiApp.scan()` (surface may evolve as module-loading ergonomics settle).
