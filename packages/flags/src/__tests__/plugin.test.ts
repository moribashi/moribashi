import { describe, expect, it } from 'vitest';
import { createApp } from '@moribashi/core';
import { flagsPlugin } from '../plugin.js';
import type { Flags } from '../flags.js';

const flagConfig = {
  'demo-flag': {
    variants: { on: true, off: false },
    defaultVariant: 'on',
    disabled: false,
  },
};

describe('flagsPlugin (root, no web)', () => {
  it('wires a working in-memory client by default and gates start on READY', async () => {
    const app = createApp();
    app.use(flagsPlugin({ flags: flagConfig }));
    await app.start();

    // setProviderAndWait resolved during onInit; a real evaluated value (below)
    // is the observable proof the provider is live.
    const flags = app.resolve<Flags>('flags');
    expect(await flags.boolean('demo-flag', false)).toBe(true);
    // Unknown flag falls back to the supplied default.
    expect(await flags.boolean('missing', true)).toBe(true);

    await app.stop();
  });

  it('resolves against an empty evaluation context at the root', async () => {
    const app = createApp();
    app.use(flagsPlugin({ flags: flagConfig }));
    await app.start();

    const flags = app.resolve<Flags>('flags');
    expect(flags.evaluationContext).toEqual({});

    await app.stop();
  });
});
