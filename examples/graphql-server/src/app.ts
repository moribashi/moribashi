import { createApp } from '@moribashi/core';
import { graphqlPlugin } from '@moribashi/graphql';
import { WEB_REQUEST_SCOPE, webPlugin } from '@moribashi/web';
import GreetService from './greet.svc.js';
import { type RequestCradle, resolvers } from './resolvers.js';
import { schema } from './schema.js';

export interface BuildAppOptions {
  /** Override the HTTP port. Defaults to 3000; pass 0 in tests to pick a random free port. */
  port?: number;
  /** Override the bind host. Defaults to webPlugin default (0.0.0.0). */
  host?: string;
  /** Serve GraphiQL at `/graphiql`. Defaults to `true` for local dev. */
  graphiql?: boolean;
}

/**
 * Wire up the minimal GraphQL-over-DI example.
 *
 * The order matters: `webPlugin` must come before `graphqlPlugin` because
 * the latter relies on `request.scope` being populated by the web layer.
 * `greetService` is registered under `WEB_REQUEST_SCOPE` so each GraphQL
 * operation gets its own fresh instance — resolvers read it off `this`.
 */
export async function buildApp(opts: BuildAppOptions = {}) {
  const app = createApp();

  app.use(webPlugin({ port: opts.port ?? 3000, host: opts.host }));
  app.use(
    graphqlPlugin<RequestCradle>({
      schema,
      resolvers,
      graphiql: opts.graphiql ?? true,
    }),
  );

  app.registerInScope(WEB_REQUEST_SCOPE, { greetService: GreetService });

  return app;
}
