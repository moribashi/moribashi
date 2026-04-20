# @examples/error-handling

Demonstrates how moribashi behaves when lifecycle hooks fail. Each scenario
lives in [`src/scenarios.ts`](./src/scenarios.ts) and is exercised by both
`pnpm start` (human-readable logs) and `pnpm test` (assertions).

## Running

```sh
pnpm start   # run all three scenarios and print their outcome
pnpm test    # assert the exact behavior in a vitest smoke test
```

## Scenarios

### A — async plugin throws from `register()`

`pluginFailsScenario()` registers a tracking service and a plugin whose
async `register()` rejects. `app.start()` first awaits pending plugin
promises, so the rejection propagates straight out of `start()`. Because the
failure happens before the singleton-resolve loop, nothing is ever
constructed, no `onInit` runs, and `app.stop()` is a safe no-op (it
short-circuits when `started` is still `false`).

### B — a service's `onInit()` throws

`onInitFailsScenario()` registers three services in order: `first`,
`exploding`, `third`. `first.onInit()` runs to completion, then
`exploding.onInit()` throws and `start()` rejects. `third` is never
constructed. **Limitation worth knowing**: because `start()` never set
`started = true`, the follow-up `app.stop()` is a no-op, so `first` is
left with its `onDestroy` hook unrun. If your services hold resources that
MUST be released on boot failure, handle cleanup manually around `start()`
or call the underlying container's `dispose()` yourself.

### C — `onDestroy()` throws during shutdown

`onDestroyRobustnessScenario()` registers `first`, `middle`, `last`, starts
the app, then calls `stop()`. Shutdown walks services in reverse
initialization order: `last.onDestroy()` runs, `middle.onDestroy()` throws,
and the exception propagates out of `stop()` — **aborting the loop before
`first.onDestroy()` can run**. The original plan described this as a
"best-effort shutdown" scenario, but the current core implementation does
NOT swallow errors in the teardown loop. This example asserts the real
behavior (`destroyedServices === ['last', 'middle']`) so the expectation is
unambiguous; if/when core evolves to a best-effort teardown, update both
the scenario expectations and this README.

## References

- [`packages/core/src/index.ts`](../../packages/core/src/index.ts) —
  `MoribashiApp.start()` / `MoribashiApp.stop()` implementation.
- [`packages/core/src/__tests__/app.lifecycle.test.ts`](../../packages/core/src/__tests__/app.lifecycle.test.ts)
  — unit tests covering the same error-propagation paths.
