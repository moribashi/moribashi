import {
  type AuthError,
  MissingPermissionError,
  NotAuthenticatedError,
} from './errors.js';
import { TokenPrincipal, type Principal } from './principal.js';

/** Roles and permissions an identity holds within one context. */
export interface Access {
  roles: string[];
  permissions: string[];
}

/**
 * App-provided (register as `accessLoader` in the container) source of
 * context-scoped authorization data. Deliberately not read from the token:
 * contextual access changes without re-login and bloats tokens.
 */
export interface AccessLoader {
  load(identity: string, contextId: string): Promise<Access>;
}

/** Authorization checks scoped to one context (org, project, tenant, …). */
export interface ContextSecurity {
  /** True when the caller holds at least one of the permissions. */
  hasAny(...permissions: string[]): Promise<boolean>;
  /** True when the caller holds at least one of the roles. */
  hasRole(...roles: string[]): Promise<boolean>;
  /** Throws unless the caller holds at least one of the permissions. */
  ensureAny(...permissions: string[]): Promise<void>;
}

/**
 * Short-TTL cache of `AccessLoader` results keyed by `identity:contextId`.
 * Shared across requests (one per plugin instance). In-flight loads are
 * coalesced; failed loads are evicted so errors are never cached.
 */
export class AccessCache {
  private readonly entries = new Map<string, { value: Promise<Access>; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(identity: string, contextId: string, load: () => Promise<Access>): Promise<Access> {
    const key = `${identity}:${contextId}`;
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const value = load();
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }
}

export interface SecurityServiceInit {
  principal: Principal;
  /** Verification failure captured by the auth hook, surfaced by `ensure*`. */
  authError?: AuthError;
  accessCache: AccessCache;
  /** Resolved lazily so apps without contextual authorization never need one. */
  getAccessLoader: () => AccessLoader | undefined;
}

/**
 * Request-scoped enforcement API over the principal and any captured
 * verification error. Registered as `securityService` in the request scope.
 */
export class SecurityService {
  readonly principal: Principal;
  private readonly authError?: AuthError;
  private readonly accessCache: AccessCache;
  private readonly getAccessLoader: () => AccessLoader | undefined;

  constructor(init: SecurityServiceInit) {
    this.principal = init.principal;
    this.authError = init.authError;
    this.accessCache = init.accessCache;
    this.getAccessLoader = init.getAccessLoader;
  }

  /**
   * Narrows to `TokenPrincipal` or throws: the captured verification error
   * when a bad token was presented (preserving the true cause, e.g.
   * `SessionExpiredError`), otherwise `NotAuthenticatedError`.
   */
  ensureAuthenticated(): TokenPrincipal {
    if (this.principal instanceof TokenPrincipal) {
      return this.principal;
    }
    throw this.authError ?? new NotAuthenticatedError();
  }

  /** True when the token carries every one of the named global permissions. */
  hasGlobal(...permissions: string[]): boolean {
    if (!(this.principal instanceof TokenPrincipal)) return false;
    const held = this.principal.permissions;
    return permissions.every((p) => held.includes(p));
  }

  /** Context-scoped checks backed by the app's `AccessLoader` (cached, short TTL). */
  withContext(contextId: string): ContextSecurity {
    const loader = this.getAccessLoader();
    if (!loader) {
      throw new Error(
        '@moribashi/auth: withContext() requires an AccessLoader — register one as "accessLoader" in the container',
      );
    }
    return new ContextSecurityImpl(this, contextId, loader, this.accessCache);
  }
}

class ContextSecurityImpl implements ContextSecurity {
  constructor(
    private readonly security: SecurityService,
    private readonly contextId: string,
    private readonly loader: AccessLoader,
    private readonly cache: AccessCache,
  ) {}

  private access(): Promise<Access> | undefined {
    const { principal } = this.security;
    if (!(principal instanceof TokenPrincipal)) return undefined;
    return this.cache.get(principal.identity, this.contextId, () =>
      this.loader.load(principal.identity, this.contextId),
    );
  }

  async hasAny(...permissions: string[]): Promise<boolean> {
    const access = await this.access();
    if (!access) return false;
    return permissions.some((p) => access.permissions.includes(p));
  }

  async hasRole(...roles: string[]): Promise<boolean> {
    const access = await this.access();
    if (!access) return false;
    return roles.some((r) => access.roles.includes(r));
  }

  async ensureAny(...permissions: string[]): Promise<void> {
    this.security.ensureAuthenticated();
    if (!(await this.hasAny(...permissions))) {
      throw new MissingPermissionError(permissions);
    }
  }
}
