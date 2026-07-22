import type { JSONWebKeySet, JWTPayload } from 'jose';

/** One trusted token issuer (an IdP realm, a k8s cluster, a CI provider, …). */
export interface IssuerConfig {
  /** OIDC discovery root — must equal the `iss` claim of its tokens exactly. */
  issuer: string;
  /** Expected `aud` claim value(s). */
  audience: string | string[];
  /** App-assigned issuer/tenant id, surfaced as `TokenPrincipal.tid`. */
  tid: number;
  /** Skip OIDC discovery and fetch keys from this JWKS URL directly. */
  jwksUri?: string;
  /**
   * Static key set — no network at all. Intended for tests and air-gapped
   * deployments. Takes precedence over `jwksUri`/discovery.
   */
  jwks?: JSONWebKeySet;
}

/**
 * The identity facts extracted from a verified payload. `audit` defaults to
 * `identity` and `type` defaults to `"USER"` when omitted.
 */
export interface MappedIdentity {
  identity: string;
  audit?: string;
  type?: string;
  /** Global permissions carried by the token. */
  permissions?: string[];
}

/**
 * Custom extraction of identity facts from a verified payload — e.g. deriving
 * an identity from `sub` for k8s ServiceAccount tokens that don't carry the
 * namespaced claim block. Throw or return `undefined` to reject the token
 * (captured as `InvalidTokenError`).
 */
export type ClaimsMapper = (
  payload: JWTPayload,
  issuer: IssuerConfig,
) => MappedIdentity | undefined;

export interface AuthPluginOptions {
  /** Trusted issuers. Tokens from any other `iss` are invalid. */
  issuers: IssuerConfig[];
  /**
   * Namespace of the identity claim block in the verified payload
   * (`payload[claims] = { identity, audit, type }` — `identity` and `audit`
   * required), or a mapper function for custom extraction.
   */
  claims: string | ClaimsMapper;
  /** TTL for cached `AccessLoader` results, in ms. Default 60_000. */
  accessCacheTtlMs?: number;
}
