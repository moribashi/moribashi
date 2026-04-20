import type { FastifyInstance } from '@moribashi/web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

type App = Awaited<ReturnType<typeof buildApp>>;

describe('examples/scoped-services smoke test — per-request scope isolation', () => {
  let app: App;
  let fastify: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ port: 0, host: '127.0.0.1' });
    await app.start();
    fastify = app.resolve<FastifyInstance>('fastify');
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('gives each request its own RequestContext with a distinct id', async () => {
    const [first, second] = await Promise.all([
      fastify.inject({ method: 'GET', url: '/whoami' }),
      fastify.inject({ method: 'GET', url: '/whoami' }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const firstBody = first.json();
    const secondBody = second.json();

    expect(firstBody.requestId).toEqual(expect.any(String));
    expect(secondBody.requestId).toEqual(expect.any(String));
    expect(firstBody.requestId).not.toBe(secondBody.requestId);
  });
});

describe('examples/scoped-services smoke test — shutdown', () => {
  it('stops cleanly and a second stop() is a no-op', async () => {
    const app = await buildApp({ port: 0, host: '127.0.0.1' });
    await app.start();

    await expect(app.stop()).resolves.toBeUndefined();
    await expect(app.stop()).resolves.toBeUndefined();
  });
});
