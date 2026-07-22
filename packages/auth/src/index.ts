export {
  AuthError,
  InvalidTokenError,
  MissingPermissionError,
  NotAuthenticatedError,
  NotAuthorizedError,
  SessionExpiredError,
} from './errors.js';
export {
  AnonymousPrincipal,
  TokenPrincipal,
  type Principal,
  type TokenPrincipalInit,
} from './principal.js';
export type {
  AuthPluginOptions,
  ClaimsMapper,
  IssuerConfig,
  MappedIdentity,
} from './config.js';
export { TokenVerifier } from './verify.js';
export {
  AccessCache,
  SecurityService,
  type Access,
  type AccessLoader,
  type ContextSecurity,
  type SecurityServiceInit,
} from './security.js';
export { authPlugin, type AuthCradle } from './plugin.js';
export {
  ServiceTokenProvider,
  workloadIdentityPlugin,
  type ServiceToken,
  type WorkloadIdentityOptions,
} from './workload-identity.js';

export function diagnostics(): any {
  return {
    module: '@moribashi/auth',
  };
}
