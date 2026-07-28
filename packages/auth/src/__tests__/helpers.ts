import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWTPayload } from 'jose';
import type { IssuerConfig } from '../config.js';

export interface TestIssuer {
  config: IssuerConfig;
  /** Sign a token as this issuer. */
  sign(payload?: JWTPayload, opts?: SignOptions): Promise<string>;
  /** A JWKS containing a different key — signatures made with it must fail. */
  privateKey: CryptoKey;
}

export interface SignOptions {
  issuer?: string;
  audience?: string;
  /** Absolute expiry in seconds since epoch; defaults to 5 minutes from now. */
  exp?: number;
  subject?: string;
}

/**
 * Build an issuer with a freshly generated RSA key and a static JWKS, so all
 * verification runs offline.
 */
export async function makeIssuer(init: {
  issuer: string;
  audience: string;
  tid: number;
}): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = `${init.tid}-key`;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const jwks: JSONWebKeySet = { keys: [jwk] };

  return {
    config: { ...init, jwks },
    privateKey,
    async sign(payload = {}, opts = {}) {
      const jwt = new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setIssuer(opts.issuer ?? init.issuer)
        .setAudience(opts.audience ?? init.audience)
        .setSubject(opts.subject ?? 'test-subject')
        .setIssuedAt();
      jwt.setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 300);
      return jwt.sign(privateKey);
    },
  };
}

/** The standard identity claim block used across tests. */
export function appBlock(identity = 'user-1', overrides: Record<string, unknown> = {}) {
  return { app: { identity, audit: identity, type: 'USER', ...overrides } };
}
