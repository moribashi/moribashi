import { createApp } from '@moribashi/core';
import { gatewayPlugin } from '@moribashi/graphql';
import { webPlugin } from '@moribashi/web';

// The gateway composes every subgraph listed below into one public schema.
// Each subgraph's URL matches the port it binds to via its own webPlugin().
const app = createApp();

app.use(webPlugin({ port: 4000 }));
app.use(gatewayPlugin({
  graphiql: true,
  subgraphs: [
    { name: 'identity', url: 'http://localhost:4001/graphql' },
    { name: 'catalog', url: 'http://localhost:4002/graphql' },
  ],
}));

await app.start();

console.log('[gateway] supergraph ready at http://localhost:4000/graphql (GraphiQL: /graphiql)');

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
