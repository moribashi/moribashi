# @moribashi/common

Shared interfaces and type guards for the Moribashi DI framework — `OnInit`, `OnDestroy`, and their duck-typed `hasOnInit`/`hasOnDestroy` checkers.

## Install

```sh
pnpm add @moribashi/common
```

Usually transitively installed by `@moribashi/core`. Install directly only if you're authoring a Moribashi plugin or utility library.

## Quickstart

```ts
import type { OnInit, OnDestroy } from '@moribashi/common';

export class BooksService implements OnInit, OnDestroy {
  async onInit() {
    /* warm up */
  }
  async onDestroy() {
    /* clean up */
  }
}
```

## API

See inline JSDoc on [`src/index.ts`](./src/index.ts).

- `OnInit`, `OnDestroy` — lifecycle interfaces
- `hasOnInit(obj)`, `hasOnDestroy(obj)` — duck-typed guards
- `diagnostics()` — package identity

## Stability

All exports `@public`.
