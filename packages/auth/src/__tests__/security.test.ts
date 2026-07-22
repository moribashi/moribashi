import { describe, expect, it, vi } from 'vitest';
import {
  MissingPermissionError,
  NotAuthenticatedError,
  SessionExpiredError,
} from '../errors.js';
import { AnonymousPrincipal, TokenPrincipal } from '../principal.js';
import { AccessCache, SecurityService, type AccessLoader } from '../security.js';

function tokenPrincipal(permissions: string[] = []) {
  return new TokenPrincipal({
    identity: 'user-1',
    audit: 'user-1',
    type: 'USER',
    tid: 1,
    claims: { sub: 'user-1' },
    permissions,
    token: 'raw.jwt.value',
  });
}

function service(init: Partial<ConstructorParameters<typeof SecurityService>[0]> = {}) {
  return new SecurityService({
    principal: AnonymousPrincipal.INSTANCE,
    accessCache: new AccessCache(60_000),
    getAccessLoader: () => undefined,
    ...init,
  });
}

describe('AnonymousPrincipal', () => {
  it('is a sealed singleton — same identity across requests', () => {
    expect(AnonymousPrincipal.INSTANCE).toBe(AnonymousPrincipal.INSTANCE);
    expect(AnonymousPrincipal.INSTANCE.authenticated).toBe(false);
    expect(Object.isFrozen(AnonymousPrincipal.INSTANCE)).toBe(true);
  });
});

describe('SecurityService.ensureAuthenticated', () => {
  it('returns the narrowed TokenPrincipal when authenticated', () => {
    const principal = tokenPrincipal();
    expect(service({ principal }).ensureAuthenticated()).toBe(principal);
  });

  it('throws NotAuthenticatedError when anonymous with no captured error', () => {
    expect(() => service().ensureAuthenticated()).toThrow(NotAuthenticatedError);
  });

  it('surfaces the captured error, preserving the true cause', () => {
    const captured = new SessionExpiredError();
    const err = (() => {
      try {
        service({ authError: captured }).ensureAuthenticated();
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBe(captured);
  });
});

describe('SecurityService.hasGlobal', () => {
  it('checks permissions carried in the token', () => {
    const sec = service({ principal: tokenPrincipal(['admin', 'read']) });
    expect(sec.hasGlobal('admin')).toBe(true);
    expect(sec.hasGlobal('admin', 'read')).toBe(true);
    expect(sec.hasGlobal('admin', 'write')).toBe(false);
    expect(sec.hasGlobal('write')).toBe(false);
  });

  it('is always false for the anonymous principal', () => {
    expect(service().hasGlobal('admin')).toBe(false);
  });
});

describe('SecurityService.withContext', () => {
  const loaderOf = (impl: AccessLoader['load']) => ({ load: vi.fn(impl) });

  it('throws a configuration error at call time when no AccessLoader is registered', () => {
    expect(() => service({ principal: tokenPrincipal() }).withContext('ctx-1')).toThrow(
      /AccessLoader/,
    );
  });

  it('resolves permissions and roles through the loader', async () => {
    const loader = loaderOf(async () => ({ roles: ['editor'], permissions: ['books:write'] }));
    const ctx = service({
      principal: tokenPrincipal(),
      getAccessLoader: () => loader,
    }).withContext('ctx-1');

    await expect(ctx.hasAny('books:write', 'books:admin')).resolves.toBe(true);
    await expect(ctx.hasAny('books:admin')).resolves.toBe(false);
    await expect(ctx.hasRole('editor')).resolves.toBe(true);
    await expect(ctx.hasRole('owner')).resolves.toBe(false);
    await expect(ctx.ensureAny('books:write')).resolves.toBeUndefined();
    await expect(ctx.ensureAny('books:admin')).rejects.toBeInstanceOf(MissingPermissionError);
    expect(loader.load).toHaveBeenCalledWith('user-1', 'ctx-1');
  });

  it('never calls the loader for the anonymous principal', async () => {
    const loader = loaderOf(async () => ({ roles: [], permissions: [] }));
    const captured = new SessionExpiredError();
    const ctx = service({
      authError: captured,
      getAccessLoader: () => loader,
    }).withContext('ctx-1');

    await expect(ctx.hasAny('anything')).resolves.toBe(false);
    await expect(ctx.hasRole('anything')).resolves.toBe(false);
    // ensureAny surfaces the captured auth error before any permission check
    await expect(ctx.ensureAny('anything')).rejects.toBe(captured);
    expect(loader.load).not.toHaveBeenCalled();
  });
});

describe('AccessCache', () => {
  const access = (permissions: string[]) => ({ roles: [], permissions });

  it('caches results per identity:contextId key with TTL expiry', async () => {
    let now = 0;
    const cache = new AccessCache(60_000, () => now);
    const load = vi.fn(async () => access(['p']));

    await cache.get('u1', 'c1', load);
    await cache.get('u1', 'c1', load);
    expect(load).toHaveBeenCalledTimes(1);

    now = 59_999;
    await cache.get('u1', 'c1', load);
    expect(load).toHaveBeenCalledTimes(1);

    now = 60_000;
    await cache.get('u1', 'c1', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('isolates keys — different identity or context loads separately', async () => {
    const cache = new AccessCache(60_000, () => 0);
    const load = vi.fn(async () => access([]));

    await cache.get('u1', 'c1', load);
    await cache.get('u1', 'c2', load);
    await cache.get('u2', 'c1', load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('propagates loader failures and does not cache them', async () => {
    const cache = new AccessCache(60_000, () => 0);
    const boom = new Error('loader down');
    const load = vi
      .fn<() => Promise<{ roles: string[]; permissions: string[] }>>()
      .mockRejectedValueOnce(boom)
      .mockResolvedValueOnce(access(['p']));

    await expect(cache.get('u1', 'c1', load)).rejects.toBe(boom);
    await expect(cache.get('u1', 'c1', load)).resolves.toEqual(access(['p']));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent loads for the same key', async () => {
    const cache = new AccessCache(60_000, () => 0);
    let resolve!: (v: { roles: string[]; permissions: string[] }) => void;
    const load = vi.fn(() => new Promise<{ roles: string[]; permissions: string[] }>((r) => (resolve = r)));

    const a = cache.get('u1', 'c1', load);
    const b = cache.get('u1', 'c1', load);
    resolve(access(['p']));
    await expect(a).resolves.toEqual(access(['p']));
    await expect(b).resolves.toEqual(access(['p']));
    expect(load).toHaveBeenCalledTimes(1);
  });
});
