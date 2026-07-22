import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceTokenProvider } from '../workload-identity.js';

describe('ServiceTokenProvider', () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'moribashi-auth-'));
    tokenPath = join(dir, 'sa-token');
    await writeFile(tokenPath, 'sa-token-v1\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function fakeEndpoint(responses: Array<{ access_token: string; expires_in?: number }>) {
    let call = 0;
    const bodies: URLSearchParams[] = [];
    const fetchImpl = vi.fn(async (_url: any, init?: any) => {
      bodies.push(new URLSearchParams(init.body.toString()));
      const payload = responses[Math.min(call++, responses.length - 1)];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies, calls: () => call };
  }

  function provider(fetchImpl: typeof fetch, now: () => number, extra: Record<string, unknown> = {}) {
    return new ServiceTokenProvider({
      tokenEndpoint: 'https://idp.test/token',
      subjectTokenPath: tokenPath,
      audience: 'my-platform',
      fetchImpl,
      now,
      ...extra,
    });
  }

  it('performs an RFC 8693 exchange with the projected SA token', async () => {
    const endpoint = fakeEndpoint([{ access_token: 'idp-token-1', expires_in: 300 }]);
    const p = provider(endpoint.fetchImpl, () => 0, { clientId: 'svc-client' });

    await expect(p.get()).resolves.toBe('idp-token-1');

    const body = endpoint.bodies[0];
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('subject_token')).toBe('sa-token-v1');
    expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt');
    expect(body.get('audience')).toBe('my-platform');
    expect(body.get('client_id')).toBe('svc-client');
  });

  it('reuses the cached token until the refresh window, then re-exchanges', async () => {
    let now = 0;
    const endpoint = fakeEndpoint([
      { access_token: 'idp-token-1', expires_in: 300 },
      { access_token: 'idp-token-2', expires_in: 300 },
    ]);
    const p = provider(endpoint.fetchImpl, () => now, { refreshSkewMs: 60_000 });

    await expect(p.get()).resolves.toBe('idp-token-1');
    now = 100_000; // well inside validity (expires at 300s, refresh from 240s)
    await expect(p.get()).resolves.toBe('idp-token-1');
    expect(endpoint.calls()).toBe(1);

    now = 240_000; // inside the refresh window
    await expect(p.get()).resolves.toBe('idp-token-2');
    expect(endpoint.calls()).toBe(2);
  });

  it('re-reads the projected file on each exchange (kubelet rotation)', async () => {
    let now = 0;
    const endpoint = fakeEndpoint([
      { access_token: 'idp-token-1', expires_in: 60 },
      { access_token: 'idp-token-2', expires_in: 60 },
    ]);
    const p = provider(endpoint.fetchImpl, () => now, { refreshSkewMs: 10_000 });

    await p.get();
    await writeFile(tokenPath, 'sa-token-v2\n');
    now = 55_000;
    await p.get();

    expect(endpoint.bodies[0].get('subject_token')).toBe('sa-token-v1');
    expect(endpoint.bodies[1].get('subject_token')).toBe('sa-token-v2');
  });

  it('coalesces concurrent refreshes into one exchange', async () => {
    const endpoint = fakeEndpoint([{ access_token: 'idp-token-1', expires_in: 300 }]);
    const p = provider(endpoint.fetchImpl, () => 0);

    const [a, b] = await Promise.all([p.get(), p.get()]);
    expect(a).toBe('idp-token-1');
    expect(b).toBe('idp-token-1');
    expect(endpoint.calls()).toBe(1);
  });

  it('surfaces exchange failures with detail and retries on the next call', async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () => {
      if (fail) return new Response('invalid_grant', { status: 400 });
      return new Response(JSON.stringify({ access_token: 'idp-token-1', expires_in: 300 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const p = provider(fetchImpl, () => 0);

    await expect(p.get()).rejects.toThrow(/HTTP 400.*invalid_grant/);
    fail = false;
    await expect(p.get()).resolves.toBe('idp-token-1');
  });
});
