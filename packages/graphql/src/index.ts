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

// --- Resolver wrapping ---

function wrapResolvers<Cradle extends object>(
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

// --- Plugin factory ---

export function graphqlPlugin<Cradle extends object>(
  opts: GraphQLPluginOptions<Cradle>,
): MoribashiPlugin {
  return {
    name: '@moribashi/graphql',
    dependencies: ['@moribashi/web'],
    register(app: MoribashiApp) {
      const fastify = app.resolve<FastifyInstance>('fastify');
      const wrappedResolvers = wrapResolvers(opts.resolvers);

      const graphiql = opts.graphiql ?? false;

      fastify.register(mercurius, {
        schema: opts.schema,
        resolvers: wrappedResolvers as any,
        graphiql,
        context: async (request: any) => {
          const scope = request.scope as MoribashiScope<Cradle> | undefined;
          if (!scope) {
            throw new Error(
              '@moribashi/graphql requires @moribashi/web to be registered first',
            );
          }
          return { scope };
        },
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
