import type { MoribashiApp, MoribashiPlugin, MoribashiScope } from '@moribashi/core';
import type { FastifyInstance } from 'fastify';
import mercurius from 'mercurius';

// --- Scope symbols ---

/**
 * Scope key used for per-request GraphQL scopes.
 *
 * Registered as `Symbol.for('moribashi.scope.graphql')` so it round-trips
 * across module boundaries. Pass this to `app.registerInScope()` /
 * `app.createScope()` if you want to share scoped registrations with
 * resolvers that run under this integration.
 *
 * @public
 */
export const GRAPHQL_SCOPE = Symbol.for('moribashi.scope.graphql');

// --- Resolver types ---

/**
 * A GraphQL resolver whose `this` is bound to a Moribashi scope cradle.
 *
 * The cradle type parameter declares which services the resolver expects
 * to read off `this`. Access (`this.booksService`) lazily resolves the
 * service from the request scope via Awilix's proxy.
 *
 * @typeParam Cradle - Shape of the request scope cradle (services available on `this`).
 * @typeParam TResult - Return type of the resolver.
 *
 * @public
 */
export type BoundResolver<Cradle extends object, TResult = unknown> = (
  this: Cradle,
  parent: any,
  args: any,
  context: any,
  info: any,
) => TResult | Promise<TResult>;

/**
 * Typed resolver map. Each field function is a `BoundResolver<Cradle>`,
 * so `this.<serviceName>` is type-checked against the cradle.
 *
 * @typeParam Cradle - Shape of the request scope cradle (services available on `this`).
 *
 * @public
 */
export type ResolverMap<Cradle extends object> = {
  [typeName: string]: {
    [fieldName: string]: BoundResolver<Cradle>;
  };
};

// --- Plugin options ---

/**
 * Options for {@link graphqlPlugin}.
 *
 * @typeParam Cradle - Shape of the request scope cradle (services available on `this` in resolvers).
 *
 * @public
 */
export interface GraphQLPluginOptions<Cradle extends object = object> {
  /** GraphQL SDL string passed through to Mercurius. */
  schema: string;
  /** Resolver map whose functions are bound to the per-request scope cradle. */
  resolvers: ResolverMap<Cradle>;
  /** Serve GraphiQL IDE at `/graphiql`. Default: `false`. */
  graphiql?: boolean;
}

// --- Resolver binding ---

/**
 * Wraps a `ResolverMap<Cradle>` so each resolver's `this` is the per-request
 * Moribashi scope cradle.
 *
 * This is the subtle contract of `@moribashi/graphql`: you write resolvers
 * as methods that read services off `this` (e.g. `this.booksService`), and
 * `bindResolvers` rewires them at registration time so every invocation is
 * `.call()`-ed with `context.scope.cradle` as the receiver. That cradle is
 * the Awilix proxy for the request scope, so service access is lazy and
 * services resolve under the scope's lifetime (SCOPED services get a fresh
 * instance per request).
 *
 * Use `bindResolvers` directly when wiring Mercurius variants manually
 * (e.g. `@mercuriusjs/federation`). For the common case, prefer
 * {@link graphqlPlugin}, which calls `bindResolvers` internally.
 *
 * Pair with {@link scopeContext} to thread the scope through Mercurius
 * context.
 *
 * @param resolvers - Typed resolver map whose functions use `this.<service>` access.
 * @returns A plain resolver map accepted by Mercurius, with `this` bound to the request scope cradle.
 *
 * @example
 * ```ts
 * import federation from '@mercuriusjs/federation';
 * import { bindResolvers, scopeContext, type ResolverMap } from '@moribashi/graphql';
 *
 * interface RequestCradle {
 *   booksService: BooksService;
 * }
 *
 * const resolvers: ResolverMap<RequestCradle> = {
 *   Query: {
 *     async books(this: RequestCradle) {
 *       return this.booksService.findAll();
 *     },
 *   },
 * };
 *
 * fastify.register(federation, {
 *   schema,
 *   resolvers: bindResolvers(resolvers),
 *   context: scopeContext,
 * });
 * ```
 *
 * @public
 */
export function bindResolvers<Cradle extends object>(
  resolvers: ResolverMap<Cradle>,
): Record<string, Record<string, Function>> {
  const wrapped: Record<string, Record<string, Function>> = {};

  for (const [typeName, fields] of Object.entries(resolvers)) {
    wrapped[typeName] = {};
    for (const [fieldName, resolver] of Object.entries(fields)) {
      if (typeof resolver === 'function') {
        wrapped[typeName][fieldName] = (
          parent: any,
          args: any,
          context: { scope: MoribashiScope<Cradle> },
          info: any,
        ) => (resolver as Function).call(context.scope.cradle, parent, args, context, info);
      }
    }
  }

  return wrapped;
}

/**
 * Mercurius `context` factory that pulls the per-request Moribashi scope
 * off the Fastify request and exposes it as `context.scope`.
 *
 * Relies on `@moribashi/web` having decorated `request.scope` on the
 * incoming request — register `webPlugin` before `graphqlPlugin` (or before
 * you register Mercurius manually). Throws if the scope is missing so
 * misconfiguration fails fast instead of silently resolving `undefined`
 * services inside resolvers.
 *
 * @param request - The Fastify request (Mercurius passes this in).
 * @returns An object with `scope` set to the request's `MoribashiScope`.
 * @throws If `request.scope` is not set (i.e. `@moribashi/web` is not registered).
 *
 * @example
 * ```ts
 * import mercurius from 'mercurius';
 * import { bindResolvers, scopeContext, type ResolverMap } from '@moribashi/graphql';
 *
 * interface RequestCradle {
 *   booksService: BooksService;
 * }
 *
 * const resolvers: ResolverMap<RequestCradle> = {
 *   Query: {
 *     async books(this: RequestCradle) {
 *       return this.booksService.findAll();
 *     },
 *   },
 * };
 *
 * fastify.register(mercurius, {
 *   schema,
 *   resolvers: bindResolvers(resolvers),
 *   context: scopeContext,
 * });
 * ```
 *
 * @public
 */
export async function scopeContext(request: any): Promise<{ scope: MoribashiScope }> {
  const scope = request.scope as MoribashiScope | undefined;
  if (!scope) {
    throw new Error('@moribashi/graphql requires @moribashi/web to be registered first');
  }
  return { scope };
}

// --- Plugin factory ---

/**
 * Moribashi plugin that registers Mercurius on the app's Fastify instance
 * with resolvers bound to per-request scopes.
 *
 * Internally this calls {@link bindResolvers} on `opts.resolvers` and wires
 * {@link scopeContext} as Mercurius's `context` factory, so every resolver
 * runs with `this` set to the request scope cradle (see `bindResolvers` for
 * the details of that contract).
 *
 * Requires `@moribashi/web` to be registered first — it resolves the
 * `fastify` instance from the root container and relies on `request.scope`
 * being decorated per request. When `graphiql: true` is set, a small
 * redirect hook sends browser GETs of `/graphql` to `/graphiql` so the IDE
 * is reachable at the main endpoint.
 *
 * @typeParam Cradle - Shape of the request scope cradle (services available on `this` in resolvers).
 * @param opts - {@link GraphQLPluginOptions} — schema, resolvers, and GraphiQL toggle.
 * @returns A {@link MoribashiPlugin} to pass to `app.use()`.
 *
 * @public
 */
export function graphqlPlugin<Cradle extends object>(
  opts: GraphQLPluginOptions<Cradle>,
): MoribashiPlugin {
  return {
    name: '@moribashi/graphql',
    register(app: MoribashiApp) {
      const fastify = app.resolve<FastifyInstance>('fastify');
      const graphiql = opts.graphiql ?? false;

      fastify.register(mercurius, {
        schema: opts.schema,
        resolvers: bindResolvers(opts.resolvers) as any,
        graphiql,
        context: scopeContext,
      });

      // Redirect browser GET /graphql to /graphiql so the IDE is served at the main endpoint
      if (graphiql) {
        fastify.addHook('onRequest', async (request, reply) => {
          if (
            request.method === 'GET' &&
            request.url === '/graphql' &&
            request.headers.accept?.includes('text/html')
          ) {
            reply.redirect('/graphiql');
          }
        });
      }
    },
  };
}

export function diagnostics(): any {
  return {
    module: '@moribashi/graphql',
  };
}
