import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asValue, createApp, type MoribashiApp, type MoribashiPlugin } from '@moribashi/core';
import { webPlugin, type FastifyInstance } from '@moribashi/web';
import { flagsPlugin } from '../index.js';

// Stands in for @moribashi/auth: registers a `principal` into the request scope
// from an X-User header, so we can exercise the flags targeting path without a
// full OIDC setup.
const fakeAuthPlugin: MoribashiPlugin = {
  name: 'fake-auth',
  register(app: MoribashiApp) {
    const fastify = app.resolve<FastifyInstance>('fastify');
    fastify.addHook('onRequest', async (request) => {
      const id = request.headers['x-user'];
      if (typeof id === 'string') {
        // `principal` isn't in WebRequestCradle here (no real @moribashi/auth),
        // so register it loosely — flags reads it structurally.
        request.scope.container.register({
          principal: asValue({ identity: id, tid: 1, type: 'USER' }),
        } as any);
      }
    });
  },
};

describe('web + (auth-like) + flags integration', () => {
  let app: MoribashiApp;
  let fastify: FastifyInstance;

  beforeAll(async () => {
    app = createApp();
    app.use(webPlugin({ port: 0, host: '127.0.0.1' }));
    app.use(fakeAuthPlugin); // before flags, so `principal` exists when the flags hook runs
    app.use(
      flagsPlugin({
        flags: {
          beta: {
            variants: { on: true, off: false },
            defaultVariant: 'off',
            disabled: false,
            contextEvaluator: (ctx) => (ctx.targetingKey === 'user-1' ? 'on' : 'off'),
          },
        },
      }),
    );

    fastify = app.resolve<FastifyInstance>('fastify');
    fastify.get('/beta', async (request) => ({
      beta: await request.scope.cradle.flags.boolean('beta', false),
      context: request.scope.cradle.evaluationContext,
    }));

    await app.start();
  });

  afterAll(async () => {
    await app.stop();
  });

  it('derives targetingKey from the principal and targets per-user', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/beta', headers: { 'x-user': 'user-1' } });
    expect(res.json()).toEqual({ beta: true, context: { targetingKey: 'user-1', tid: 1, type: 'USER' } });
  });

  it('targets a different user to the default variant', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/beta', headers: { 'x-user': 'user-2' } });
    expect(res.json()).toEqual({ beta: false, context: { targetingKey: 'user-2', tid: 1, type: 'USER' } });
  });

  it('uses an empty context and default variant for anonymous requests', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/beta' });
    expect(res.json()).toEqual({ beta: false, context: {} });
  });
});
