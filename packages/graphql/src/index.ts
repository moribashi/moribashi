import type { FastifyInstance } from 'fastify';
import type { MoribashiApp, MoribashiPlugin, MoribashiScope } from '@moribashi/core';
import mercurius from 'mercurius';
import { mercuriusFederationPlugin } from '@mercuriusjs/federation';
import mercuriusGatewayPlugin from '@mercuriusjs/gateway';

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
  /**
   * Register this schema as an Apollo Federation v1 subgraph (via
   * `@mercuriusjs/federation`) instead of a standalone schema, so a
   * `gatewayPlugin()` gateway can discover and compose it.
   *
   * A federated schema is still a fully valid, independently queryable
   * GraphQL server on its own — federating it only adds the `_service { sdl }`
   * introspection field a gateway needs. Running it standalone (no gateway
   * present) works exactly like a non-federated service.
   *
   * SDL convention when federated: use `extend type Query` / `extend type
   * Mutation` instead of `type Query` / `type Mutation`.
   *
   * Default: false. Will become the default in a future release — see
   * https://github.com/moribashi/moribashi/issues/4
   */
  federated?: boolean;
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
      const plugin = (opts.federated ? mercuriusFederationPlugin : mercurius) as any;

      fastify.register(plugin, {
        schema: opts.schema,
        resolvers: bindResolvers(opts.resolvers) as any,
        graphiql,
        context: scopeContext,
      });

      addGraphiqlRedirect(fastify, graphiql);
    },
  };
}

// --- Gateway ---

export interface GatewaySubgraph {
  /** Name used to identify this subgraph in gateway logs and hooks. */
  name: string;
  /** The subgraph's GraphQL endpoint, e.g. `http://users.internal/graphql`. */
  url: string;
  /**
   * If false (default), the gateway still starts up when this subgraph isn't
   * reachable yet, and picks it up on a later poll. Set true to require it at
   * startup.
   */
  mandatory?: boolean;
}

export interface GatewayPluginOptions {
  /** Subgraphs to discover and compose into the supergraph. */
  subgraphs: GatewaySubgraph[];
  /** Serve GraphiQL IDE at /graphiql. Default: false */
  graphiql?: boolean;
  /** Per-attempt reachability retries for each subgraph before giving up on it for that attempt. Default: 3 */
  retryServicesCount?: number;
  /** Delay between per-subgraph reachability retries, in ms. Default: 2000 */
  retryServicesInterval?: number;
  /** How often to re-poll subgraphs for schema/topology changes, in ms. Default: 10000 */
  pollingInterval?: number;
}

/**
 * Composes federated subgraphs (registered via `graphqlPlugin({ federated: true })`)
 * into one public supergraph, via `@mercuriusjs/gateway`. Like `graphqlPlugin()`,
 * this is a Moribashi app in its own right — it participates in DI, lifecycle,
 * and the plugin system rather than being a bare Fastify process.
 *
 * Non-mandatory subgraphs (the default) let the gateway start even when a
 * subgraph isn't up yet; `retryServicesCount`/`retryServicesInterval` retry
 * reachability per attempt, and `pollingInterval` keeps re-checking afterward.
 * If literally none of the subgraphs are reachable, registration still fails
 * and the process exits — deliberately: recovering from a fully-cold-start
 * failure is left to the process supervisor (e.g. Kubernetes restarting the
 * pod) rather than an in-process retry loop, since retrying a Fastify
 * instance whose boot has already failed isn't a safe operation.
 */
export function gatewayPlugin(opts: GatewayPluginOptions): MoribashiPlugin {
  return {
    name: '@moribashi/graphql/gateway',
    register(app: MoribashiApp) {
      const fastify = app.resolve<FastifyInstance>('fastify');
      const graphiql = opts.graphiql ?? false;

      fastify.get('/health', async () => ({ status: 'ok' }));

      fastify.register(mercuriusGatewayPlugin as any, {
        graphiql,
        gateway: {
          services: opts.subgraphs.map((subgraph) => ({
            name: subgraph.name,
            url: subgraph.url,
            mandatory: subgraph.mandatory ?? false,
          })),
          retryServicesCount: opts.retryServicesCount ?? 3,
          retryServicesInterval: opts.retryServicesInterval ?? 2000,
          pollingInterval: opts.pollingInterval ?? 10000,
        },
      } as any);

      addGraphiqlRedirect(fastify, graphiql);
    },
  };
}

// --- Shared plugin helpers ---

/** Redirect browser GET /graphql to /graphiql so the IDE is served at the main endpoint. */
function addGraphiqlRedirect(fastify: FastifyInstance, graphiql: boolean): void {
  if (!graphiql) return;
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

export function diagnostics(): any {
  return {
    module: '@moribashi/graphql',
  };
}
