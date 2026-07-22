import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asValue, createApp, type MoribashiApp } from '@moribashi/core';
import { webPlugin, type FastifyInstance } from '@moribashi/web';
import { graphqlPlugin, type ResolverMap } from '@moribashi/graphql';
import { authPlugin, type AuthCradle } from '../index.js';
import { makeIssuer, appBlock, type TestIssuer } from './helpers.js';

const schema = `
  type Query {
    public: String
    me: String
    audit: String
    hasAdmin: Boolean
    inContext: Boolean
  }
`;

const resolvers: ResolverMap<AuthCradle> = {
  Query: {
    public() {
      return 'public-ok';
    },
    me() {
      return this.securityService.ensureAuthenticated().identity;
    },
    audit() {
      return this.securityService.ensureAuthenticated().audit;
    },
    hasAdmin() {
      return this.securityService.hasGlobal('admin');
    },
    async inContext() {
      return this.securityService.withContext('ctx-1').hasAny('books:write');
    },
  },
};

describe('web + auth + graphql integration', () => {
  let idp: TestIssuer;
  let app: MoribashiApp;
  let url: string;

  beforeAll(async () => {
    idp = await makeIssuer({ issuer: 'https://idp.test/realms/main', audience: 'my-platform', tid: 1 });

    app = createApp();
    app.use(webPlugin({ port: 0, host: '127.0.0.1' }));
    app.use(authPlugin({ issuers: [idp.config], claims: 'app' }));
    app.use(graphqlPlugin<AuthCradle>({ schema, resolvers }));
    app.container.register({
      accessLoader: asValue({
        load: async (identity: string) =>
          identity === 'user-1'
            ? { roles: ['editor'], permissions: ['books:write'] }
            : { roles: [], permissions: [] },
      }),
    });
    await app.start();

    const fastify = app.resolve<FastifyInstance>('fastify');
    const address = fastify.server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}/graphql`;
  });

  afterAll(async () => {
    await app.stop();
  });

  async function gql(query: string, token?: string) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ query }),
    });
    return res.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>;
  }

  it('serves public fields to anonymous callers without errors', async () => {
    const body = await gql('{ public hasAdmin }');
    expect(body.errors).toBeUndefined();
    expect(body.data).toEqual({ public: 'public-ok', hasAdmin: false });
  });

  it('resolves public and rejects protected fields in one anonymous operation', async () => {
    const body = await gql('{ public me }');
    expect(body.data.public).toBe('public-ok');
    expect(body.data.me).toBeNull();
    expect(body.errors?.map((e) => e.message)).toContain('Not authenticated');
  });

  it('authenticates a valid bearer token and exposes the principal via DI', async () => {
    const token = await idp.sign(appBlock('user-1', { permissions: ['admin'] }));
    const authed = await gql('{ me audit hasAdmin inContext }', token);
    expect(authed.errors).toBeUndefined();
    expect(authed.data).toEqual({
      me: 'user-1',
      audit: 'user-1',
      hasAdmin: true,
      inContext: true,
    });
  });

  it('surfaces the captured expiry error on protected fields while public fields still resolve', async () => {
    const expired = await idp.sign(appBlock(), { exp: Math.floor(Date.now() / 1000) - 60 });
    const body = await gql('{ public me }', expired);
    expect(body.data.public).toBe('public-ok');
    expect(body.data.me).toBeNull();
    expect(body.errors?.map((e) => e.message)).toContain('Token expired');
  });

  it('treats a garbage bearer token as anonymous with a captured invalid-token error', async () => {
    const body = await gql('{ public me }', 'garbage');
    expect(body.data.public).toBe('public-ok');
    expect(body.errors?.map((e) => e.message)).toContain('Malformed token');
  });
});
