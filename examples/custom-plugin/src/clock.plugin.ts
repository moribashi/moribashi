import { asValue, type MoribashiPlugin } from '@moribashi/core';

export interface ClockConfig {
  intervalMs: number;
}

export interface Clock {
  readonly tickCount: number;
  readonly started: boolean;
  readonly stopped: boolean;
}

export function clockPlugin(opts: ClockConfig): MoribashiPlugin {
  class ClockService implements Clock {
    private timer: ReturnType<typeof setInterval> | null = null;
    tickCount = 0;
    started = false;
    stopped = false;

    private readonly intervalMs: number;

    constructor({ clockConfig }: { clockConfig: ClockConfig }) {
      this.intervalMs = clockConfig.intervalMs;
    }

    onInit(): void {
      this.started = true;
      this.timer = setInterval(() => {
        this.tickCount += 1;
        console.log('tick', this.tickCount);
      }, this.intervalMs);
      if (typeof this.timer.unref === 'function') {
        this.timer.unref();
      }
    }

    onDestroy(): void {
      if (this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.stopped = true;
      console.log('stopped');
    }
  }

  return {
    name: '@examples/custom-plugin/clock',
    register(app) {
      app.container.register({ clockConfig: asValue(opts) });
      app.register({ clock: ClockService });
    },
  };
}
