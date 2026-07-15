import { createApp } from '@moribashi/core';
import { graphqlPlugin } from '@moribashi/graphql';
import { webPlugin } from '@moribashi/web';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from './schema.js';
import { resolvers } from './resolvers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = createApp();

app.use(webPlugin({ port: 4002 }));
app.use(graphqlPlugin({ schema, resolvers, graphiql: true, federated: true }));

await app.scan(['**/*.svc.ts'], { cwd: __dirname });

await app.start();

console.log('[catalog] subgraph ready at http://localhost:4002/graphql (GraphiQL: /graphiql)');

const shutdown = async () => {
  await app.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
