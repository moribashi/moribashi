import type { FastifyInstance } from 'fastify';
import type { MoribashiApp, MoribashiPlugin, MoribashiScope } from '@moribashi/core';
import mercurius from 'mercurius';

// --- Scope symbols ---

export const GRAPHQL_SCOPE = Symbol.for('moribashi.scope.graphql');

// --- Resolver types ---

export type BoundResolver<Cradle extends object, TResult = unknown> = (
  this: Cradle,
  parent: any,
  args: any,
  context: any,
  info: any,
) => TResult | Promise<TResult>;

export type ResolverMap<Cradle extends object> = {
  [typeName: string]: {
    [fieldName: string]: BoundResolver<Cradle>;
  };
};

// --- Plugin options ---

export interface GraphQLPluginOptions<Cradle extends object = object> {
  schema: string;
  resolvers: ResolverMap<Cradle>;
  /** Serve GraphiQL IDE at /graphiql. Default: false */
  graphiql?: boolean;
}

// --- Resolver binding ---

/**
 * Wraps a `ResolverMap<Cradle>` so each resolver's `this` is bound to the
 * request scope's cradle. Use this when wiring up Mercurius variants
 * (e.g. `@mercuriusjs/federation`) manually instead of via `graphqlPlugin()`.
 *
 * Pair with `scopeContext` to thread the scope through Mercurius context:
 *
 * ```ts
 * fastify.register(federation, {
 *   schema,
 *   resolvers: bindResolvers(resolvers),
 *   context: scopeContext,
 * });
 * ```
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
 * Mercurius `context` function that extracts the per-request scope set by
 * `@moribashi/web`. Pass this to Mercurius (or federation) `context` option
 * alongside `bindResolvers`:
 *
 * ```ts
 * fastify.register(federation, {
 *   schema,
 *   resolvers: bindResolvers(resolvers),
 *   context: scopeContext,
 * });
 * ```
 */
export async function scopeContext(request: any): Promise<{ scope: MoribashiScope }> {
  const scope = request.scope as MoribashiScope | undefined;
  if (!scope) {
    throw new Error(
      '@moribashi/graphql requires @moribashi/web to be registered first',
    );
  }
  return { scope };
}

// --- Plugin factory ---

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
