import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { asClass, asValue, Lifetime, type MoribashiApp, type MoribashiPlugin, type MoribashiScope } from '@moribashi/core';
import type { OnInit, OnDestroy } from '@moribashi/common';

// Re-export Fastify types for downstream consumers
export type { FastifyInstance, FastifyRequest, FastifyReply };

// --- Scope symbols ---

export const WEB_APP_SCOPE = Symbol.for('moribashi.scope.web.app');
export const WEB_REQUEST_SCOPE = Symbol.for('moribashi.scope.web.request');

// --- Type augmentation ---

declare module 'fastify' {
  interface FastifyRequest {
    scope: MoribashiScope;
  }
}

// --- Config ---

export interface WebPluginOptions {
  port?: number;
  host?: string;
}

interface WebConfig {
  port: number;
  host: string;
}

// --- WebServer service (lifecycle-managed) ---

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
        request.scope = undefined as unknown as MoribashiScope;
      });

      // Dispose on aborted requests too
      fastify.addHook('onRequestAbort', async (request: FastifyRequest) => {
        await request.scope?.dispose();
        request.scope = undefined as unknown as MoribashiScope;
      });
    },
  };
}

export function diagnostics(): any {
  return {
    module: '@moribashi/web',
  };
}
