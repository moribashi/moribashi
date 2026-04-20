import { createApp } from '@moribashi/core';
import { clockPlugin } from './clock.plugin.js';

export interface BuildAppOptions {
  intervalMs?: number;
}

export function buildApp(opts: BuildAppOptions = {}) {
  const app = createApp();
  app.use(clockPlugin({ intervalMs: opts.intervalMs ?? 50 }));
  return app;
}
