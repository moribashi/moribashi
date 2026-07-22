import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { MoribashiApp, MoribashiPlugin, MoribashiScope } from '@moribashi/core';
import mercurius from 'mercurius';
import { mercuriusFederationPlugin } from '@mercuriusjs/federation';
import mercuriusGatewayPlugin from '@mercuriusjs/gateway';
import { useSofa } from 'sofa-api';

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

// --- REST (sofa-api) options ---

/** Per-operation route override, mirroring sofa-api's `RouteConfig`. */
export interface RestRouteConfig {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path?: string;
  responseStatus?: number;
  tags?: string[];
  description?: string;
}

export interface RestOptions {
  /** Base path REST endpoints are mounted under. Default: '/api' */
  basePath?: string;
  /** OpenAPI document info. The spec is served at `${basePath}/openapi.json`. */
  openApi?: {
    title?: string;
    description?: string;
    version?: string;
    /** Path of the spec relative to `basePath`, or false to disable. Default: '/openapi.json' */
    endpoint?: string | false;
  };
  /** Serve Swagger UI at `${basePath}/docs`. Set false to disable. Default: true */
  swaggerUi?: boolean | { endpoint?: string };
  /** How deep sofa-api expands nested object fields when deriving queries. Default: sofa-api's default (1). */
  depthLimit?: number;
  /** Types/fields sofa-api should not treat as models, e.g. `["Book.author"]`. */
  ignore?: string[];
  /** Per-operation overrides keyed like `"Query.books"` / `"Mutation.addBook"`. */
  routes?: Record<string, RestRouteConfig>;
}

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
  /**
   * Also expose every query/mutation as a REST endpoint (via sofa-api), with
   * an always-in-sync OpenAPI spec and Swagger UI. Pass `true` for defaults
   * (endpoints under `/api`, spec at `/api/openapi.json`, UI at `/api/docs`)
   * or a `RestOptions` object to customize.
   *
   * REST requests run through the same Fastify instance, so they get the same
   * per-request DI scope as GraphQL resolvers — `this.someService` works
   * identically in both.
   *
   * Default: false
   */
  rest?: boolean | RestOptions;
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

      if (opts.rest) {
        mountRest(fastify, opts.rest === true ? {} : opts.rest);
      }

      addGraphiqlRedirect(fastify, graphiql);
    },
  };
}

/**
 * Mounts sofa-api on the app's Fastify instance, reusing the executable
 * schema Mercurius built (so REST and GraphQL can never drift). Registered
 * after Mercurius so `fastify.graphql.schema` is available when it runs.
 */
function mountRest(fastify: FastifyInstance, rest: RestOptions): void {
  const basePath = rest.basePath ?? '/api';

  fastify.register(async (instance) => {
    const sofa = useSofa({
      basePath,
      schema: (instance as any).graphql.schema,
      depthLimit: rest.depthLimit,
      ignore: rest.ignore,
      routes: rest.routes as any,
      context: ((serverContext: { fastifyRequest: FastifyRequest }) =>
        scopeContext(serverContext.fastifyRequest)) as any,
      openAPI: {
        info: {
          title: rest.openApi?.title,
          description: rest.openApi?.description,
          version: rest.openApi?.version,
        },
        endpoint: rest.openApi?.endpoint,
      } as any,
      swaggerUI:
        rest.swaggerUi === false
          ? ({ endpoint: false } as any)
          : typeof rest.swaggerUi === 'object'
            ? rest.swaggerUi
            : undefined,
    });

    // Sofa reads the request body itself (as a fetch Request), so keep
    // Fastify from consuming/parsing it. Content-type parsers are
    // encapsulated: this only affects routes registered in this context.
    instance.removeAllContentTypeParsers();
    instance.addContentTypeParser('*', (_req, payload, done) => {
      done(null, payload);
    });

    instance.route({
      url: `${basePath}/*`,
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const response: Response | undefined = await (sofa as any).handleNodeRequestAndResponse(
          request,
          reply,
          { fastifyRequest: request },
        );
        if (!response) {
          return reply.callNotFound();
        }
        response.headers.forEach((value, key) => {
          reply.header(key, value);
        });
        reply.status(response.status);
        reply.send(response.body);
        return reply;
      },
    });
  });
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
