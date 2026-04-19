import type { OnDestroy, OnInit } from '@moribashi/common';
import {
  asClass,
  asValue,
  Lifetime,
  type MoribashiApp,
  type MoribashiPlugin,
  type MoribashiScope,
} from '@moribashi/core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';

// Re-export Fastify types for downstream consumers
export type { FastifyInstance, FastifyReply, FastifyRequest };

// --- Scope symbols ---

/**
 * Scope key for app-level web registrations shared across all HTTP requests.
 *
 * Reserved for future use by `@moribashi/web`; plugins and apps do not need
 * to register into it directly today. Prefer {@link WEB_REQUEST_SCOPE} for
 * per-request services.
 *
 * @public
 */
export const WEB_APP_SCOPE: symbol = Symbol.for('moribashi.scope.web.app');

/**
 * Scope key for per-request service registrations.
 *
 * Pass this symbol to {@link MoribashiApp.registerInScope} to declare which
 * services each incoming HTTP request should see in its own scope. The
 * plugin creates a fresh scope on the Fastify `onRequest` hook, seeds it
 * with `request` and `reply`, and disposes it on `onResponse` (firing
 * `onDestroy` on any resolved scoped services).
 *
 * @example
 * ```ts
 * app.registerInScope(WEB_REQUEST_SCOPE, {
 *   booksService: BooksService,
 * });
 * ```
 *
 * @public
 */
export const WEB_REQUEST_SCOPE: symbol = Symbol.for('moribashi.scope.web.request');

// --- Type augmentation ---

declare module 'fastify' {
  /**
   * Module augmentation: every `FastifyRequest` gains a `scope` property
   * pointing to the per-request {@link MoribashiScope} created by
   * {@link webPlugin}. Route handlers and Fastify hooks can use it to
   * resolve services registered under {@link WEB_REQUEST_SCOPE}:
   *
   * ```ts
   * fastify.get('/books', async (request) => {
   *   const svc = request.scope.resolve<BooksService>('booksService');
   *   return svc.findAll();
   * });
   * ```
   *
   * The scope is populated in the `onRequest` hook and disposed in
   * `onResponse` / `onRequestAbort`, so it is always defined inside a
   * request lifecycle.
   *
   * @public
   */
  interface FastifyRequest {
    scope: MoribashiScope;
  }
}

// --- Config ---

/**
 * Options accepted by {@link webPlugin}.
 *
 * Both fields are optional; defaults are `port: 3000` and `host: '0.0.0.0'`.
 * Pass `port: 0` in tests to bind to a random free port.
 *
 * @public
 */
export interface WebPluginOptions {
  /** TCP port to listen on. Defaults to `3000`. Pass `0` for a random free port. */
  port?: number;
  /** Bind address. Defaults to `'0.0.0.0'` (all interfaces). */
  host?: string;
}

interface WebConfig {
  port: number;
  host: string;
}

// --- WebServer service (lifecycle-managed) ---

/**
 * Singleton service that owns the Fastify listen/close lifecycle. Registered
 * automatically by {@link webPlugin}; apps rarely interact with it directly.
 */
class WebServer implements OnInit, OnDestroy {
  private fastify: FastifyInstance;
  private webConfig: WebConfig;

  constructor({ fastify, webConfig }: { fastify: FastifyInstance; webConfig: WebConfig }) {
    this.fastify = fastify;
    this.webConfig = webConfig;
  }

  async onInit() {
    const { port, host } = this.webConfig;
    await this.fastify.listen({ port, host });
    console.log(`[WebServer] listening on ${host}:${port}`);
  }

  async onDestroy() {
    await this.fastify.close();
    console.log('[WebServer] closed');
  }
}

// --- Plugin factory ---

/**
 * Moribashi plugin that wires a Fastify server into the DI container and
 * creates a fresh per-request scope for every incoming HTTP request.
 *
 * Registers three singletons on the root container:
 *
 * - `fastify` — the `FastifyInstance` (use it to attach routes and plugins)
 * - `webConfig` — the resolved `{ port, host }` pair
 * - `webServer` — a lifecycle-managed service that calls `fastify.listen`
 *   during `app.start()` and `fastify.close()` during `app.stop()`
 *
 * Installs three Fastify hooks:
 *
 * - `onRequest` creates a scope keyed by {@link WEB_REQUEST_SCOPE}, seeds it
 *   with the current `request` and `reply`, and assigns it to
 *   `request.scope`.
 * - `onResponse` disposes the scope after the response is sent, firing
 *   `onDestroy` on any resolved scoped services.
 * - `onRequestAbort` disposes the scope if the client disconnects early.
 *
 * Register services that should live for a single request via
 * {@link MoribashiApp.registerInScope} using {@link WEB_REQUEST_SCOPE} as
 * the key.
 *
 * @param opts Optional listen config. See {@link WebPluginOptions} for
 *   defaults.
 * @returns A {@link MoribashiPlugin} ready to pass to `app.use()`.
 *
 * @see {@link WEB_REQUEST_SCOPE} for per-request registrations.
 * @see FastifyRequest.scope for the module augmentation that exposes the
 *   scope on every request.
 *
 * @example
 * ```ts
 * import { createApp } from '@moribashi/core';
 * import { webPlugin, WEB_REQUEST_SCOPE, type FastifyInstance } from '@moribashi/web';
 *
 * class BooksService {
 *   findAll() {
 *     return [{ id: 1, title: 'Moby-Dick' }];
 *   }
 * }
 *
 * const app = createApp();
 * app.use(webPlugin({ port: 3000 }));
 * app.registerInScope(WEB_REQUEST_SCOPE, { booksService: BooksService });
 *
 * const fastify = app.resolve<FastifyInstance>('fastify');
 * fastify.get('/books', async (request) => {
 *   const svc = request.scope.resolve<BooksService>('booksService');
 *   return svc.findAll();
 * });
 *
 * await app.start();
 * // ... later:
 * await app.stop();
 * ```
 *
 * @public
 */
export function webPlugin(opts?: WebPluginOptions): MoribashiPlugin {
  return {
    name: '@moribashi/web',
    register(app: MoribashiApp) {
      const fastify = Fastify();

      const webConfig: WebConfig = {
        port: opts?.port ?? 3000,
        host: opts?.host ?? '0.0.0.0',
      };

      // Register Fastify instance and config in root container
      app.container.register({
        fastify: asValue(fastify),
        webConfig: asValue(webConfig),
        webServer: asClass(WebServer).setLifetime(Lifetime.SINGLETON),
      });

      // Per-request scope lifecycle
      fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        const scope = app.createScope(WEB_REQUEST_SCOPE);
        scope.container.register({
          request: asValue(request),
          reply: asValue(reply),
        });
        request.scope = scope;
      });

      // Dispose request scope after response
      fastify.addHook('onResponse', async (request: FastifyRequest) => {
        await request.scope?.dispose();
      });

      // Dispose on aborted requests too
      fastify.addHook('onRequestAbort', async (request: FastifyRequest) => {
        await request.scope?.dispose();
      });
    },
  };
}

/**
 * Package identity probe. Returns `{ module: '@moribashi/web' }` so tooling
 * can verify which copy of the package is loaded at runtime.
 *
 * @returns An object identifying this package.
 */
export function diagnostics(): any {
  return {
    module: '@moribashi/web',
  };
}
