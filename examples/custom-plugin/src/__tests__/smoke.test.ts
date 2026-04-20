import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import type { Clock } from '../clock.plugin.js';

type App = ReturnType<typeof buildApp>;

describe('examples/custom-plugin smoke test — clockPlugin lifecycle', () => {
  let app: App;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    await app?.stop();
    logSpy.mockRestore();
  });

  it('fires onInit on start and ticks at the configured interval', async () => {
    app = buildApp({ intervalMs: 10 });
    await app.start();

    const clock = app.resolve<Clock>('clock');
    expect(clock.started).toBe(true);
    expect(clock.stopped).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(clock.tickCount).toBeGreaterThan(0);
    expect(logSpy).toHaveBeenCalledWith('tick', expect.any(Number));
  });

  it('fires onDestroy on stop, clears the timer, and logs "stopped"', async () => {
    app = buildApp({ intervalMs: 10 });
    await app.start();

    const clock = app.resolve<Clock>('clock');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const ticksAtStop = clock.tickCount;
    expect(ticksAtStop).toBeGreaterThan(0);

    await app.stop();

    expect(clock.stopped).toBe(true);
    expect(logSpy).toHaveBeenCalledWith('stopped');

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(clock.tickCount).toBe(ticksAtStop);
  });
});
