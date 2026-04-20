import { createApp, type MoribashiPlugin } from '@moribashi/core';

/**
 * Result of a scenario run — exposes enough internal state for the smoke test
 * to assert the exact behavior that moribashi implements today.
 */
export interface ScenarioResult {
  /** Did `app.start()` reject? */
  startRejected: boolean;
  /** The message on the rejection, if any. */
  startError?: string;
  /** Did `app.stop()` reject? */
  stopRejected: boolean;
  /** The message on the stop rejection, if any. */
  stopError?: string;
  /** Services whose `onInit()` ran to completion. */
  initializedServices: string[];
  /** Services whose `onDestroy()` ran to completion. */
  destroyedServices: string[];
}

/**
 * Scenario A — an async plugin that throws from `register()`.
 *
 * Expected behavior (verified against the core implementation):
 * - `app.start()` rejects with the plugin's error.
 * - No singletons are resolved (the failure happens before the resolve loop),
 *   so no `onInit` hooks run and there is nothing for `onDestroy` to clean up.
 * - `app.stop()` is a no-op because `started` never flipped to true.
 */
export async function pluginFailsScenario(): Promise<ScenarioResult> {
  const initializedServices: string[] = [];
  const destroyedServices: string[] = [];

  class TrackingService {
    readonly label = 'tracking';
    async onInit() {
      initializedServices.push(this.label);
    }
    async onDestroy() {
      destroyedServices.push(this.label);
    }
  }

  const failingPlugin: MoribashiPlugin = {
    name: 'failing-async-plugin',
    async register() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('plugin boot failed');
    },
  };

  const app = createApp();
  app.register({ tracking: TrackingService });
  app.use(failingPlugin);

  const result: ScenarioResult = {
    startRejected: false,
    stopRejected: false,
    initializedServices,
    destroyedServices,
  };

  try {
    await app.start();
  } catch (err) {
    result.startRejected = true;
    result.startError = err instanceof Error ? err.message : String(err);
  }

  // Even though start failed, stop() must be safe to call — it short-circuits
  // because the app never finished starting.
  try {
    await app.stop();
  } catch (err) {
    result.stopRejected = true;
    result.stopError = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * Scenario B — a service whose `onInit()` throws.
 *
 * Expected behavior (verified against the core implementation):
 * - `app.start()` rejects with the `onInit` error.
 * - Services registered earlier that had already completed `onInit` remain
 *   constructed, but `started` never flips to true, so their `onDestroy`
 *   hooks will NOT run when `stop()` is called. This is a real moribashi
 *   limitation worth being aware of — see README.
 */
export async function onInitFailsScenario(): Promise<ScenarioResult> {
  const initializedServices: string[] = [];
  const destroyedServices: string[] = [];

  class FirstService {
    readonly label = 'first';
    async onInit() {
      initializedServices.push(this.label);
    }
    async onDestroy() {
      destroyedServices.push(this.label);
    }
  }

  class ExplodingService {
    async onInit() {
      throw new Error('onInit exploded');
    }
    async onDestroy() {
      destroyedServices.push('exploding');
    }
  }

  class ThirdService {
    readonly label = 'third';
    async onInit() {
      initializedServices.push(this.label);
    }
    async onDestroy() {
      destroyedServices.push(this.label);
    }
  }

  const app = createApp();
  // Registration order is also init order.
  app.register({
    first: FirstService,
    exploding: ExplodingService,
    third: ThirdService,
  });

  const result: ScenarioResult = {
    startRejected: false,
    stopRejected: false,
    initializedServices,
    destroyedServices,
  };

  try {
    await app.start();
  } catch (err) {
    result.startRejected = true;
    result.startError = err instanceof Error ? err.message : String(err);
  }

  try {
    await app.stop();
  } catch (err) {
    result.stopRejected = true;
    result.stopError = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * Scenario C — verify what happens when one service's `onDestroy()` throws.
 *
 * The original plan described this as "best-effort shutdown", but the core
 * implementation does NOT currently swallow errors during the `onDestroy`
 * loop — the first throw propagates out of `app.stop()` and aborts the rest
 * of the teardown. This scenario demonstrates that actual behavior so the
 * test can assert reality, not an aspiration.
 *
 * Registration order: `first`, `middle` (throws in onDestroy), `last`.
 * Stop walks in reverse: `last` → `middle` (throws) → `first` (skipped).
 */
export async function onDestroyRobustnessScenario(): Promise<ScenarioResult> {
  const initializedServices: string[] = [];
  const destroyedServices: string[] = [];

  class FirstService {
    readonly label = 'first';
    async onInit() {
      initializedServices.push(this.label);
    }
    async onDestroy() {
      destroyedServices.push(this.label);
    }
  }

  class MiddleService {
    readonly label = 'middle';
    async onInit() {
      initializedServices.push(this.label);
    }
    async onDestroy() {
      destroyedServices.push(this.label);
      throw new Error('onDestroy exploded');
    }
  }

  class LastService {
    readonly label = 'last';
    async onInit() {
      initializedServices.push(this.label);
    }
    async onDestroy() {
      destroyedServices.push(this.label);
    }
  }

  const app = createApp();
  app.register({
    first: FirstService,
    middle: MiddleService,
    last: LastService,
  });

  const result: ScenarioResult = {
    startRejected: false,
    stopRejected: false,
    initializedServices,
    destroyedServices,
  };

  try {
    await app.start();
  } catch (err) {
    result.startRejected = true;
    result.startError = err instanceof Error ? err.message : String(err);
  }

  try {
    await app.stop();
  } catch (err) {
    result.stopRejected = true;
    result.stopError = err instanceof Error ? err.message : String(err);
  }

  return result;
}
