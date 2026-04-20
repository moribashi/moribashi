import { createApp } from '@moribashi/core';
import type { FastifyInstance } from '@moribashi/web';
import { WEB_REQUEST_SCOPE, webPlugin } from '@moribashi/web';
import RequestContext from './request-context.svc.js';

export interface BuildAppOptions {
  /** Override the HTTP port. Defaults to 3000; pass 0 in tests to pick a random free port. */
  port?: number;
  /** Override the bind host. Defaults to webPlugin default (0.0.0.0). */
  host?: string;
}

interface RequestCradle {
  requestContext: RequestContext;
}

export async function buildApp(opts: BuildAppOptions = {}) {
  const app = createApp();

  app.use(webPlugin({ port: opts.port ?? 3000, host: opts.host }));
  app.registerInScope(WEB_REQUEST_SCOPE, { requestContext: RequestContext });

  const fastify = app.resolve<FastifyInstance>('fastify');

  fastify.get('/whoami', async (request) => {
    const { requestContext } = request.scope.cradle as RequestCradle;
    return { requestId: requestContext.id };
  });

  return app;
}
