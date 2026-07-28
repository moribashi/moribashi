import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import type { AuthPluginOptions, ClaimsMapper, IssuerConfig, MappedIdentity } from './config.js';
import { InvalidTokenError, SessionExpiredError } from './errors.js';
import { TokenPrincipal } from './principal.js';

interface IssuerEntry {
  config: IssuerConfig;
  getKey?: JWTVerifyGetKey;
  discovery?: Promise<JWTVerifyGetKey>;
}

/**
 * Verifies bearer tokens against a set of trusted issuers. The unverified
 * `iss` claim selects the issuer entry; its JWKS (static, direct URI, or via
 * OIDC discovery — resolved once and cached) verifies the signature. jose's
 * remote key set handles key rotation and cooldown internally.
 */
export class TokenVerifier {
  private readonly byIssuer = new Map<string, IssuerEntry>();
  private readonly claims: string | ClaimsMapper;

  constructor(opts: Pick<AuthPluginOptions, 'issuers' | 'claims'>) {
    for (const config of opts.issuers) {
      this.byIssuer.set(config.issuer, { config });
    }
    this.claims = opts.claims;
  }

  /**
   * Verify a raw JWT and build its principal.
   * Throws `SessionExpiredError` for expired tokens and `InvalidTokenError`
   * for everything else (malformed, bad signature, wrong audience, unlisted
   * issuer, missing identity claims).
   */
  async verify(token: string): Promise<TokenPrincipal> {
    let iss: string | undefined;
    try {
      iss = decodeJwt(token).iss;
    } catch (err) {
      throw new InvalidTokenError('Malformed token', { cause: err });
    }

    const entry = iss !== undefined ? this.byIssuer.get(iss) : undefined;
    if (!entry) {
      throw new InvalidTokenError(`Token issuer is not trusted: ${iss ?? '<none>'}`);
    }

    const { config } = entry;
    let payload: JWTPayload;
    try {
      const { payload: verified } = await jwtVerify(token, await this.getKey(entry), {
        issuer: config.issuer,
        audience: config.audience,
      });
      payload = verified;
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) {
        throw new SessionExpiredError('Token expired', { cause: err });
      }
      throw new InvalidTokenError('Token verification failed', { cause: err });
    }

    const mapped = this.mapIdentity(payload, config);
    return new TokenPrincipal({
      identity: mapped.identity,
      audit: mapped.audit ?? mapped.identity,
      type: mapped.type ?? 'USER',
      tid: config.tid,
      claims: payload,
      permissions: mapped.permissions,
      token,
    });
  }

  private async getKey(entry: IssuerEntry): Promise<JWTVerifyGetKey> {
    if (entry.getKey) return entry.getKey;

    const { config } = entry;
    if (config.jwks) {
      entry.getKey = createLocalJWKSet(config.jwks);
      return entry.getKey;
    }
    if (config.jwksUri) {
      entry.getKey = createRemoteJWKSet(new URL(config.jwksUri));
      return entry.getKey;
    }

    // OIDC discovery, performed once per issuer; concurrent requests share
    // the in-flight promise, and a failed discovery is retried next time.
    entry.discovery ??= this.discoverJwks(config.issuer).catch((err) => {
      entry.discovery = undefined;
      throw err;
    });
    entry.getKey = await entry.discovery;
    return entry.getKey;
  }

  private async discoverJwks(issuer: string): Promise<JWTVerifyGetKey> {
    const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${res.status}`);
    }
    const metadata = (await res.json()) as { jwks_uri?: string };
    if (!metadata.jwks_uri) {
      throw new Error(`OIDC discovery for ${issuer} returned no jwks_uri`);
    }
    return createRemoteJWKSet(new URL(metadata.jwks_uri));
  }

  private mapIdentity(payload: JWTPayload, config: IssuerConfig): MappedIdentity {
    if (typeof this.claims === 'function') {
      let mapped: MappedIdentity | undefined;
      try {
        mapped = this.claims(payload, config);
      } catch (err) {
        throw new InvalidTokenError('Claims mapper rejected token', { cause: err });
      }
      if (!mapped || typeof mapped.identity !== 'string' || mapped.identity.length === 0) {
        throw new InvalidTokenError('Claims mapper returned no identity');
      }
      return mapped;
    }

    const block = payload[this.claims];
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      throw new InvalidTokenError(`Token is missing the "${this.claims}" identity claim block`);
    }
    const { identity, audit, type, permissions } = block as Record<string, unknown>;
    if (typeof identity !== 'string' || identity.length === 0 || typeof audit !== 'string' || audit.length === 0) {
      throw new InvalidTokenError(
        `Identity claim block "${this.claims}" must contain "identity" and "audit"`,
      );
    }
    return {
      identity,
      audit,
      type: typeof type === 'string' ? type : undefined,
      permissions: Array.isArray(permissions)
        ? permissions.filter((p): p is string => typeof p === 'string')
        : undefined,
    };
  }
}
