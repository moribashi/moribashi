/**
 * Error taxonomy for @moribashi/auth.
 *
 * Verification failures are *captured* into the request scope rather than
 * rejecting the request — they surface when the app calls an `ensure*`
 * method, preserving the true cause (e.g. `SessionExpiredError` instead of
 * a generic "not authenticated").
 */

export class AuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** No credentials were presented and the operation requires them. */
export class NotAuthenticatedError extends AuthError {
  constructor(message = 'Not authenticated', options?: ErrorOptions) {
    super(message, options);
  }
}

/** A token was presented but has expired. */
export class SessionExpiredError extends AuthError {
  constructor(message = 'Session expired', options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * A token was presented but could not be accepted: malformed, bad signature,
 * wrong audience, unlisted issuer, or missing the required identity claims.
 */
export class InvalidTokenError extends AuthError {
  constructor(message = 'Invalid token', options?: ErrorOptions) {
    super(message, options);
  }
}

/** The caller is authenticated but not allowed to perform the operation. */
export class NotAuthorizedError extends AuthError {
  constructor(message = 'Not authorized', options?: ErrorOptions) {
    super(message, options);
  }
}

/** A specific permission check failed. */
export class MissingPermissionError extends NotAuthorizedError {
  readonly permissions: readonly string[];

  constructor(permissions: readonly string[], options?: ErrorOptions) {
    super(`Missing permission: ${permissions.join(', ')}`, options);
    this.permissions = permissions;
  }
}
