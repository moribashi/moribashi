import type { JWTPayload } from 'jose';

/**
 * Who is calling. A discriminated union: check `principal.authenticated`
 * (or `instanceof TokenPrincipal`) to narrow.
 */
export type Principal = AnonymousPrincipal | TokenPrincipal;

/**
 * The unauthenticated caller. Sealed singleton — there is only ever one
 * anonymous user, so identity comparison (`===`) works across requests.
 */
export class AnonymousPrincipal {
  static readonly INSTANCE = new AnonymousPrincipal();

  readonly authenticated = false as const;

  private constructor() {
    Object.freeze(this);
  }
}

export interface TokenPrincipalInit {
  identity: string;
  audit: string;
  type: string;
  tid: number;
  claims: JWTPayload;
  permissions?: readonly string[];
  token: string;
}

/**
 * A caller established from a verified bearer token. Immutable token facts
 * only — no authorization state, no loaders, no caches.
 */
export class TokenPrincipal {
  readonly authenticated = true as const;
  /** Stable identity from the claim block (or claims mapper). */
  readonly identity: string;
  /** Acting identity for audit trails; equals `identity` until impersonation exists. */
  readonly audit: string;
  /** App-defined vocabulary, e.g. "USER" | "SERVICE". */
  readonly type: string;
  /** The `tid` of the issuer entry that validated this token. */
  readonly tid: number;
  /** Full verified JWT payload. */
  readonly claims: JWTPayload;
  /** Global permissions carried in the token claims. */
  readonly permissions: readonly string[];

  readonly #token: string;

  constructor(init: TokenPrincipalInit) {
    this.identity = init.identity;
    this.audit = init.audit;
    this.type = init.type;
    this.tid = init.tid;
    this.claims = init.claims;
    this.permissions = Object.freeze([...(init.permissions ?? [])]);
    this.#token = init.token;
    Object.freeze(this);
  }

  /** The raw JWT, for propagation to downstream calls. */
  token(): string {
    return this.#token;
  }
}
