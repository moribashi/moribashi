import type { FastifyInstance } from '@moribashi/web';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

type App = Awaited<ReturnType<typeof buildApp>>;

describe('examples/graphql-server smoke test — bindResolvers + scopeContext', () => {
  let app: App;
  let fastify: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ port: 0, host: '127.0.0.1', graphiql: false });
    await app.start();
    fastify = app.resolve<FastifyInstance>('fastify');
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('resolves `hello` via `this.greetService` in the request scope', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/graphql',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ query: '{ hello(name: "DI") }' }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ hello: 'Hello, DI!' });
  });

  it('gives each concurrent GraphQL request its own GreetService instance', async () => {
    const [first, second] = await Promise.all([
      fastify.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: '{ instanceId }' }),
      }),
      fastify.inject({
        method: 'POST',
        url: '/graphql',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ query: '{ instanceId }' }),
      }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const firstId = first.json().data.instanceId;
    const secondId = second.json().data.instanceId;

    expect(firstId).toEqual(expect.any(Number));
    expect(secondId).toEqual(expect.any(Number));
    expect(firstId).not.toBe(secondId);
  });
});

describe('examples/graphql-server smoke test — shutdown', () => {
  it('stops cleanly and a second stop() is a no-op', async () => {
    const app = await buildApp({ port: 0, host: '127.0.0.1', graphiql: false });
    await app.start();

    await expect(app.stop()).resolves.toBeUndefined();
    await expect(app.stop()).resolves.toBeUndefined();
  });
});
