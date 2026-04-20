import { describe, expect, it } from 'vitest';
import {
  onDestroyRobustnessScenario,
  onInitFailsScenario,
  pluginFailsScenario,
} from '../scenarios.js';

describe('examples/error-handling smoke test', () => {
  it('Scenario A: async plugin error propagates out of app.start() and stop() is a no-op', async () => {
    const result = await pluginFailsScenario();

    expect(result.startRejected).toBe(true);
    expect(result.startError).toBe('plugin boot failed');
    // start() throws before any singleton is resolved, so nothing was ever
    // initialized and stop() has nothing to clean up.
    expect(result.initializedServices).toEqual([]);
    expect(result.destroyedServices).toEqual([]);
    // stop() is safe even after a failed start — it short-circuits because
    // `started` never flipped to true.
    expect(result.stopRejected).toBe(false);
  });

  it('Scenario B: onInit error propagates and already-initialized services are NOT destroyed', async () => {
    const result = await onInitFailsScenario();

    expect(result.startRejected).toBe(true);
    expect(result.startError).toBe('onInit exploded');
    // `first` was fully initialized before `exploding` threw; `third` never ran.
    expect(result.initializedServices).toEqual(['first']);
    // Moribashi limitation: because `started` never flipped to true, stop() is
    // a no-op, so `first.onDestroy` does NOT run. See README.
    expect(result.destroyedServices).toEqual([]);
    expect(result.stopRejected).toBe(false);
  });

  it('Scenario C: a throwing onDestroy() aborts the rest of the teardown (NOT best-effort)', async () => {
    const result = await onDestroyRobustnessScenario();

    expect(result.startRejected).toBe(false);
    // All three services were initialized in registration order.
    expect(result.initializedServices).toEqual(['first', 'middle', 'last']);
    // stop() walks in reverse; `last` destroys, then `middle` throws, which
    // aborts the loop before `first.onDestroy` can run.
    expect(result.destroyedServices).toEqual(['last', 'middle']);
    expect(result.stopRejected).toBe(true);
    expect(result.stopError).toBe('onDestroy exploded');
  });
});
