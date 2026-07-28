import { describe, expect, it, beforeAll } from 'vitest';
import { TokenVerifier } from '../verify.js';
import { InvalidTokenError, SessionExpiredError } from '../errors.js';
import { TokenPrincipal } from '../principal.js';
import { makeIssuer, appBlock, type TestIssuer } from './helpers.js';

describe('TokenVerifier', () => {
  let idp: TestIssuer;
  let cluster: TestIssuer;

  beforeAll(async () => {
    idp = await makeIssuer({ issuer: 'https://idp.test/realms/main', audience: 'my-platform', tid: 1 });
    cluster = await makeIssuer({ issuer: 'https://oidc.eks.test/id/ABC123', audience: 'my-platform', tid: 2 });
  });

  const verifier = () =>
    new TokenVerifier({ issuers: [idp.config, cluster.config], claims: 'app' });

  it('verifies a valid token into a TokenPrincipal', async () => {
    const token = await idp.sign(appBlock('user-1', { permissions: ['admin', 'read'] }));
    const principal = await verifier().verify(token);

    expect(principal).toBeInstanceOf(TokenPrincipal);
    expect(principal.authenticated).toBe(true);
    expect(principal.identity).toBe('user-1');
    expect(principal.audit).toBe('user-1');
    expect(principal.type).toBe('USER');
    expect(principal.tid).toBe(1);
    expect(principal.permissions).toEqual(['admin', 'read']);
    expect(principal.claims.iss).toBe('https://idp.test/realms/main');
    expect(principal.token()).toBe(token);
  });

  it('selects the issuer entry by iss (tid follows the issuer)', async () => {
    const verify = verifier();
    const clusterVerifier = new TokenVerifier({
      issuers: [idp.config, cluster.config],
      claims: (payload) => ({ identity: payload.sub!, type: 'SERVICE' }),
    });
    const token = await cluster.sign({}, { subject: 'system:serviceaccount:ns:sa' });
    const principal = await clusterVerifier.verify(token);
    expect(principal.tid).toBe(2);
    expect(principal.identity).toBe('system:serviceaccount:ns:sa');
    expect(principal.type).toBe('SERVICE');
    expect(principal.audit).toBe('system:serviceaccount:ns:sa');

    // The same token through the namespace-claims verifier lacks the block
    await expect(verify.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects an expired token with SessionExpiredError', async () => {
    const token = await idp.sign(appBlock(), { exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('rejects a wrong-audience token', async () => {
    const token = await idp.sign(appBlock(), { audience: 'someone-else' });
    const err = await verifier().verify(token).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect(err).not.toBeInstanceOf(SessionExpiredError);
  });

  it('rejects tokens from unlisted issuers', async () => {
    const stranger = await makeIssuer({ issuer: 'https://evil.test', audience: 'my-platform', tid: 9 });
    const token = await stranger.sign(appBlock());
    const err = await verifier().verify(token).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect(err.message).toContain('not trusted');
  });

  it('rejects a token signed with the wrong key', async () => {
    // forged has idp's issuer string but its own key, unknown to idp's JWKS
    const forged = await makeIssuer({ issuer: idp.config.issuer, audience: 'my-platform', tid: 1 });
    const token = await forged.sign(appBlock());
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects malformed tokens', async () => {
    await expect(verifier().verify('not-a-jwt')).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a cryptographically valid token missing the claim block', async () => {
    const token = await idp.sign({});
    const err = await verifier().verify(token).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidTokenError);
    expect(err.message).toContain('"app"');
  });

  it('rejects a claim block missing identity or audit', async () => {
    const token = await idp.sign({ app: { identity: 'user-1' } });
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(InvalidTokenError);

    const token2 = await idp.sign({ app: { audit: 'user-1' } });
    await expect(verifier().verify(token2)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('treats a throwing or empty claims mapper as an invalid token', async () => {
    const token = await idp.sign(appBlock());

    const throwing = new TokenVerifier({
      issuers: [idp.config],
      claims: () => {
        throw new Error('nope');
      },
    });
    await expect(throwing.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);

    const empty = new TokenVerifier({ issuers: [idp.config], claims: () => undefined });
    await expect(empty.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });
});
