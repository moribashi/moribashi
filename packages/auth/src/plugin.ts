import { asValue, type MoribashiApp, type MoribashiPlugin } from '@moribashi/core';
import type { FastifyInstance, FastifyRequest } from '@moribashi/web';
import type { AccessLoader } from './security.js';
import type { AuthPluginOptions } from './config.js';
import { AuthError, InvalidTokenError } from './errors.js';
import { AnonymousPrincipal, type Principal } from './principal.js';
import { AccessCache, SecurityService } from './security.js';
import { TokenVerifier } from './verify.js';

/**
 * What `authPlugin` adds to the request cradle, alongside `request`/`reply`
 * from `@moribashi/web`. Merge into your request-scope `Cradle` type.
 */
export interface AuthCradle {
  principal: Principal;
  securityService: SecurityService;
  authError: AuthError | undefined;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Resource-server authentication: validates inbound bearer tokens against the
 * configured OIDC issuers and registers `principal` and `securityService`
 * into the per-request scope.
 *
 * Register after `webPlugin` (it needs the Fastify instance — same ordering
 * rule as `graphqlPlugin`). The hook never rejects a request: a missing
 * header yields the anonymous principal, and an invalid/expired token yields
 * the anonymous principal plus a captured `AuthError` that surfaces when the
 * app calls an `ensure*` method.
 */
export function authPlugin(opts: AuthPluginOptions): MoribashiPlugin {
  return {
    name: '@moribashi/auth',
    register(app: MoribashiApp) {
      let fastify: FastifyInstance;
      try {
        fastify = app.resolve<FastifyInstance>('fastify');
      } catch (err) {
        throw new Error('@moribashi/auth requires @moribashi/web to be registered first', {
          cause: err,
        });
      }

      const verifier = new TokenVerifier(opts);
      const accessCache = new AccessCache(opts.accessCacheTtlMs ?? 60_000);
      const getAccessLoader = (): AccessLoader | undefined =>
        app.container.hasRegistration('accessLoader')
          ? app.resolve<AccessLoader>('accessLoader')
          : undefined;

      // Runs after @moribashi/web's onRequest hook (registration order), so
      // request.scope already exists.
      fastify.addHook('onRequest', async (request: FastifyRequest) => {
        const { principal, authError } = await establishPrincipal(verifier, request.headers.authorization);

        const securityService = new SecurityService({
          principal,
          authError,
          accessCache,
          getAccessLoader,
        });

        request.scope.container.register({
          principal: asValue(principal),
          securityService: asValue(securityService),
          authError: asValue(authError),
        });
      });
    },
  };
}

async function establishPrincipal(
  verifier: TokenVerifier,
  header: string | undefined,
): Promise<{ principal: Principal; authError?: AuthError }> {
  if (header === undefined) {
    return { principal: AnonymousPrincipal.INSTANCE };
  }

  const match = BEARER.exec(header);
  if (!match) {
    return {
      principal: AnonymousPrincipal.INSTANCE,
      authError: new InvalidTokenError('Malformed Authorization header'),
    };
  }

  try {
    return { principal: await verifier.verify(match[1]) };
  } catch (err) {
    return {
      principal: AnonymousPrincipal.INSTANCE,
      authError:
        err instanceof AuthError
          ? err
          : new InvalidTokenError('Token verification failed', { cause: err }),
    };
  }
}
