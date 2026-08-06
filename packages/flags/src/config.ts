import { InMemoryProvider, type EvaluationContext, type Provider } from '@openfeature/server-sdk';
import type { PrincipalLike } from './context.js';

/**
 * Static in-memory flag configuration — the exact shape accepted by
 * OpenFeature's bundled {@link InMemoryProvider}. Re-typed here so callers get
 * IntelliSense without importing from the SDK directly.
 *
 * @example
 * {
 *   'new-checkout': {
 *     variants: { on: true, off: false },
 *     defaultVariant: 'off',
 *     disabled: false,
 *     contextEvaluator: (ctx) => (ctx.targetingKey === 'u_123' ? 'on' : 'off'),
 *   },
 * }
 */
export type InMemoryFlagConfig = ConstructorParameters<typeof InMemoryProvider>[0];

/**
 * Points at any OFREP-compliant server (flagd, GO Feature Flag, Flipt, a
 * homegrown service, …). Configured with just a URL — no vendor SDK. Requires
 * the optional peer `@openfeature/ofrep-provider`, imported lazily only when
 * this option is set.
 */
export interface OfrepOptions {
  /**
   * Base URL for OFREP requests. The provider appends
   * `/ofrep/v1/evaluate/flags/{key}`. Relative paths are supported.
   */
  baseUrl: string;
  /** Static headers sent on every request (e.g. an API key). */
  headers?: Record<string, string>;
  /** Per-request abort timeout in ms. Default 10_000 (provider default). */
  timeoutMs?: number;
}

export interface FlagsPluginOptions {
  /**
   * Full control: any OpenFeature {@link Provider}. Highest precedence — use
   * this for a vendor SDK (LaunchDarkly, Split, Flagsmith, flagd native, …) or
   * a custom provider.
   */
  provider?: Provider;
  /**
   * Standards-based default: an OFREP server addressed by URL. Second
   * precedence. Requires the optional peer `@openfeature/ofrep-provider`.
   */
  ofrep?: OfrepOptions;
  /**
   * Zero-dependency fallback (the ships-by-default provider): static flags
   * evaluated in-process. Ideal for tests, local dev, and air-gapped runs.
   * Used when neither `provider` nor `ofrep` is given.
   */
  flags?: InMemoryFlagConfig;
  /**
   * OpenFeature domain for multi-provider setups. When set, the plugin binds
   * the provider and client to this domain instead of the global default.
   */
  domain?: string;
  /**
   * Maps the request principal into an evaluation context. Defaults to
   * {@link defaultContextFrom} (identity → `targetingKey`). Only used when
   * `@moribashi/web` is present.
   */
  contextFrom?: (principal: PrincipalLike) => EvaluationContext;
}

/**
 * The single pluggability seam. Precedence: `provider` > `ofrep` > in-memory.
 * Async because the OFREP provider is imported lazily so apps that never use it
 * don't pay for (or need to install) the peer dependency.
 */
export async function resolveProvider(opts: FlagsPluginOptions): Promise<Provider> {
  if (opts.provider) return opts.provider;

  if (opts.ofrep) {
    let OFREPProvider: typeof import('@openfeature/ofrep-provider').OFREPProvider;
    try {
      ({ OFREPProvider } = await import('@openfeature/ofrep-provider'));
    } catch (err) {
      throw new Error(
        "@moribashi/flags: the `ofrep` option requires the optional peer '@openfeature/ofrep-provider' — install it, pass your own `provider`, or drop `ofrep` to use the in-memory default",
        { cause: err },
      );
    }
    const { baseUrl, headers, timeoutMs } = opts.ofrep;
    return new OFREPProvider({
      baseUrl,
      timeoutMs,
      headers: headers ? Object.entries(headers) : undefined,
    });
  }

  return new InMemoryProvider(opts.flags ?? {});
}
