import { describe, expect, it } from 'vitest';
import { InMemoryProvider, type Provider } from '@openfeature/server-sdk';
import { resolveProvider } from '../config.js';

describe('resolveProvider precedence', () => {
  it('returns an explicit provider ahead of everything else', async () => {
    const custom = { metadata: { name: 'custom' } } as unknown as Provider;
    const provider = await resolveProvider({
      provider: custom,
      ofrep: { baseUrl: 'https://flags.test' },
      flags: {},
    });
    expect(provider).toBe(custom);
  });

  it('builds an OFREP provider from a baseUrl when no explicit provider is given', async () => {
    const provider = await resolveProvider({
      ofrep: { baseUrl: 'https://flags.test', headers: { authorization: 'Bearer x' } },
    });
    expect(provider).not.toBeInstanceOf(InMemoryProvider);
    expect(provider.metadata.name.toLowerCase()).toContain('remote evaluation protocol');
  });

  it('falls back to the bundled in-memory provider by default', async () => {
    const provider = await resolveProvider({});
    expect(provider).toBeInstanceOf(InMemoryProvider);
  });

  it('honors static in-memory flag config', async () => {
    const provider = await resolveProvider({
      flags: {
        'demo-flag': {
          variants: { on: true, off: false },
          defaultVariant: 'on',
          disabled: false,
        },
      },
    });
    expect(provider).toBeInstanceOf(InMemoryProvider);
    const details = await provider.resolveBooleanEvaluation('demo-flag', false, {}, console);
    expect(details.value).toBe(true);
  });
});
