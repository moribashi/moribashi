import {
  asClass,
  asValue,
  Lifetime,
  type MoribashiApp,
  type MoribashiPlugin,
} from '@moribashi/core';
import type { OnInit, OnDestroy } from '@moribashi/common';
import {
  OpenFeature,
  type Client,
  type EvaluationContext,
  type Provider,
} from '@openfeature/server-sdk';
import { resolveProvider, type FlagsPluginOptions } from './config.js';
import { defaultContextFrom, type PrincipalLike } from './context.js';
import { Flags } from './flags.js';

/** What `flagsPlugin` registers on the root container. */
export interface FlagsCradle {
  /** The OpenFeature client, shared process-wide (domain-bound if configured). */
  featureClient: Client;
  /** Request-context-aware evaluation wrapper (SCOPED). */
  flags: Flags;
  /**
   * Current evaluation context. Empty at the root; overridden per-request by
   * the web hook with the principal-derived context.
   */
  evaluationContext: EvaluationContext;
}

/**
 * Drives the OpenFeature provider through Moribashi's lifecycle: sets it on
 * `onInit` (via `setProviderAndWait`, so `app.start()` blocks until the provider
 * is READY — same gating as pg migrations) and tears it down on `onDestroy`.
 */
class FeatureProviderLifecycle implements OnInit, OnDestroy {
  private readonly provider: Provider;
  private readonly domain?: string;

  constructor({ provider, domain }: { provider: Provider; domain?: string }) {
    this.provider = provider;
    this.domain = domain;
  }

  async onInit(): Promise<void> {
    if (this.domain) {
      await OpenFeature.setProviderAndWait(this.domain, this.provider);
    } else {
      await OpenFeature.setProviderAndWait(this.provider);
    }
  }

  async onDestroy(): Promise<void> {
    // Closes every provider and calls each one's onClose(), flushing vendor SDKs.
    await OpenFeature.clearProviders();
  }
}

/**
 * Feature flags for Moribashi via OpenFeature.
 *
 * Ships a working default (in-memory) so an app always has flags with zero
 * infrastructure; pass `ofrep: { baseUrl }` for the standards-based remote
 * default, or `provider` for any OpenFeature provider. See {@link FlagsPluginOptions}.
 *
 * When `@moribashi/web` is registered, register this plugin **after** it (and
 * after `@moribashi/auth`, if used) so the per-request `onRequest` hook can read
 * the principal and derive an evaluation context. Without web, only the root
 * client is wired and evaluations use the empty/global context.
 */
export function flagsPlugin(opts: FlagsPluginOptions = {}): MoribashiPlugin {
  return {
    name: '@moribashi/flags',
    async register(app: MoribashiApp) {
      const provider = await resolveProvider(opts);
      const { domain } = opts;
      const client = domain ? OpenFeature.getClient(domain) : OpenFeature.getClient();

      app.container.register({
        featureProviderLifecycle: asClass(FeatureProviderLifecycle)
          .inject(() => ({ provider, domain }))
          .setLifetime(Lifetime.SINGLETON),
        featureClient: asValue(client),
        // Root default; per-request scope overrides this. Registered so the
        // SCOPED `flags` resolves cleanly under Awilix strict mode even at root.
        evaluationContext: asValue<EvaluationContext>({}),
        flags: asClass(Flags).setLifetime(Lifetime.SCOPED),
      });

      wireRequestContext(app, opts);
    },
  };
}

/**
 * If `@moribashi/web` is present, enrich each request's scope with an
 * `evaluationContext` derived from the principal. No-op otherwise, keeping web
 * (and auth) soft dependencies.
 */
function wireRequestContext(app: MoribashiApp, opts: FlagsPluginOptions): void {
  let fastify: { addHook: (name: string, fn: (request: any) => void | Promise<void>) => void };
  try {
    fastify = app.resolve('fastify');
  } catch {
    return; // no @moribashi/web — root client only
  }

  const contextFrom = opts.contextFrom ?? defaultContextFrom;

  // Runs after @moribashi/web (creates request.scope) and @moribashi/auth
  // (registers `principal`) by registration order.
  fastify.addHook('onRequest', async (request: any) => {
    const scope = request.scope;
    if (!scope?.container) return;

    const principal: PrincipalLike = scope.container.hasRegistration('principal')
      ? scope.container.resolve('principal')
      : undefined;

    scope.container.register({
      evaluationContext: asValue(contextFrom(principal)),
    });
  });
}
