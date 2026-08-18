# @moribashi/kafka

Kafka/Redpanda transport as a standard moribashi plugin: connection lifecycle,
DI registration, schema registration at boot, and graceful shutdown through the
app's own lifecycle.

It carries **zero domain knowledge** — no event envelope, no topic naming
convention, no aggregate concepts. Those belong to the service. This package's
job is to get a schema-validated payload onto a topic and to fail loudly at boot
when the contract is wrong.

The layering mirrors [`@moribashi/pg`](../pg): a framework-free core
(`createKafkaClient()` / `createProducer()`, usable from a plain script) and a
plugin (`kafkaPlugin()`) that registers it into the DI container.

## Quickstart

```ts
import { createApp } from '@moribashi/core';
import { kafkaPlugin, type KafkaProducer } from '@moribashi/kafka';

const app = createApp();

app.use(kafkaPlugin({
  clientId: 'svc-iam',
  brokers: ['redpanda:9092'],
  schemaRegistry: { url: 'http://redpanda:8081' },
  schemasDir: './schemas',
  registerSchemas: true,   // this service *owns* these subjects
}));

await app.start();

const producer = app.resolve<KafkaProducer>('producer');

await producer.send({
  topic: 'iam.identity.created.v1',
  key: identity.tenantId,          // per message — this is the partition key
  value: { id: identity.id, email: identity.email },
});

await app.stop();                  // disconnects the producer via onDestroy
```

Everything above can come from the environment instead — `kafkaPlugin()` with no
arguments is a valid call in a properly configured pod.

## What gets registered

| Name | What it is |
| --- | --- |
| `kafkaClient` | Resolved config, `@platformatic/kafka` connection options, the registry client |
| `schemaRegistry` | The shared Confluent Schema Registry client |
| `producer` | A schema-aware `KafkaProducer` (**singleton**, so `app.stop()` disconnects it) |

## Configuration

Config is resolved from the environment, overridden by anything passed to
`kafkaPlugin()`, and **validated eagerly** — a bad broker list or a missing
registry URL throws a `KafkaConfigError` where the plugin is constructed, not on
the first send.

| Variable | Maps to |
| --- | --- |
| `KAFKA_CLIENT_ID` | `clientId` — required |
| `KAFKA_BROKERS` | `brokers`, comma-separated — required |
| `KAFKA_SCHEMA_REGISTRY_URL` | `schemaRegistry.url` — required |
| `KAFKA_SCHEMA_REGISTRY_USERNAME` / `..._PASSWORD` | Registry basic auth (set together) |
| `KAFKA_SCHEMAS_DIR` | `schemasDir` — default `./schemas` |
| `KAFKA_SASL_MECHANISM` | `oauthbearer`, `scram-sha-256`, `scram-sha-512`, `plain` |
| `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` | SCRAM/PLAIN credentials |
| `KAFKA_TLS` / `KAFKA_TLS_CA_PATH` / `KAFKA_TLS_REJECT_UNAUTHORIZED` | Broker TLS |
| `KAFKA_ALLOW_AUTO_TOPIC_CREATION` | **Local dev only** — see below |

There are deliberately **no defaults for the three endpoints**. A service that
silently falls back to `localhost` in production is a worse failure than a
crashloop.

`allowAutoTopicCreation` is env-only and defaults to `false`, matching the
cluster's `auto_create_topics_enabled: false`. There is no config field for it,
so code cannot turn it on: a topic that springs into existence because someone
typo'd a name is a silent data-loss bug.

## Schemas: declarative, not migrations

Put the `.proto` files this service **owns** in `schemasDir`, named after their
subject:

```
schemas/
  iam.identity.created.v1-value.proto
```

The subject is the filename minus `.proto`, and the produce side derives the
same name from the topic (Confluent's `TopicNameStrategy`: `<topic>-value`).
That shared derivation is what keeps registration and encoding pointed at one
subject.

With `registerSchemas: true`, every file is registered during plugin
`register()` — which `app.start()` awaits before resolving any singleton — so an
incompatible change throws before the app can serve, the pod crashloops, and
ArgoCD goes red.

This borrows the *ergonomics* of `@moribashi/pg`'s `SqlMigrationSource` (a
directory of files in the service repo, processed at boot) and **none of its
machinery**. There are no version prefixes, no ordering, no local ledger, no
`down`. Registration is declarative and idempotent: you post the schema you
currently want, and the registry either hands back the id it already had or
rejects the change. **The registry is the ledger** — which is why drift is
impossible and why no local state is needed.

- Unchanged schema → same id, no-op.
- Incompatible change → `SchemaRegistrationError`, thrown at boot.
- Missing or empty directory → warning, app starts normally.

**Only producers register.** `registerSchemas` is off by default and must be
opted into. A consumer that registers a schema is a service asserting a contract
it does not own.

### Checking compatibility from CI

`checkSchemaCompatibility()` runs the same check against a reachable registry
*without* registering anything, and returns a report instead of throwing — so
CI can fail a PR rather than a pod:

```ts
const results = await checkSchemaCompatibility({ client });
const broken = results.filter(r => !r.compatible);
if (broken.length) {
  console.error(broken);
  process.exit(1);
}
```

Ravn's registry is in-cluster only today, so this isn't wired into CI yet. It
exists so that wiring it up later needs no new code.

## Producing

```ts
interface ProducerMessage<T> {
  topic: string;
  value: T;                       // encoded against `<topic>-value`
  key?: string | Buffer;          // partition key, per message
  headers?: Record<string, string>;
  partition?: number;
  timestamp?: bigint;
}
```

The key is **per message**, not per batch. One `send()` regularly spans several
entities, and a single key applied to a whole batch mis-partitions every message
but the first entity's — a bug that only shows up as out-of-order events under
load.

Encoding happens before any produce call, so a batch that cannot be encoded
never half-publishes. Failures surface as `SchemaEncodeError` carrying the topic,
subject, and schema id.

Resolved `subject → schemaId` pairs are cached with a TTL (default 5 minutes;
`schemaCacheTtlMs: 0` disables it) and can be dropped explicitly with
`producer.clearSchemaCache(subject?)`. A forever-cache would mean a registry
update is never picked up without a pod restart.

## SASL / OAUTHBEARER

The cluster runs unauthenticated today; SASL is supported now so turning it on is
a config change.

SCRAM and PLAIN come entirely from the environment. OAUTHBEARER cannot — a token
is not an env var — so the mechanism comes from `KAFKA_SASL_MECHANISM` and the
token comes from code:

```ts
import { workloadIdentityPlugin, type ServiceToken } from '@moribashi/auth';

app.use(workloadIdentityPlugin({ /* ... */ }));
app.use(kafkaPlugin({
  tokenProvider: () => app.resolve<ServiceToken>('serviceToken').get(),
}));
```

`@moribashi/kafka` does **not** depend on `@moribashi/auth`. The build order is
`common → core → {cli, graphql, kafka, pg, web} → auth`, and a kafka→auth edge
would invert it. The `tokenProvider` indirection lets a service wire the two
together without either package knowing about the other — and it works just as
well with any other token source.

The provider is handed to `@platformatic/kafka` as a credential provider, so it
is called per authentication. A refresh-ahead provider like `serviceToken` keeps
working across reconnects, and no token is ever captured at construction time.

## Escape hatches

- `producer.producer` — the underlying `@platformatic/kafka` `Producer`.
- `createKafkaClient(existingClient)` — BYO client, detected structurally.
- `createProducer({ producer })` — BYO `Producer` instance.
- `registerSchemas({ registry })` — BYO Schema Registry client.

## No signal handlers

This package registers no `SIGTERM`/`SIGINT` handlers and never calls
`process.exit()`. Disconnection is `producer.onDestroy()`, fired by `app.stop()`
in reverse initialization order. A transport library racing the service's own
shutdown is a source of dropped in-flight messages, not a feature.

## Local development

```sh
docker compose -f packages/kafka/docker-compose.yml up -d
KAFKA_INTEGRATION=1 pnpm --filter @moribashi/kafka run test
docker compose -f packages/kafka/docker-compose.yml down -v
```

Single-node Redpanda plus Console on <http://localhost:8080>. The integration
suite is skipped unless `KAFKA_INTEGRATION=1`; it is the only place the real
Confluent wire format is exercised end to end.

## Dependencies

- **`@platformatic/kafka`** — pure-JS, TypeScript-native Kafka client. Services
  build on `node:24-alpine`, where native bindings are a musl risk. `kafkajs`
  was rejected: last published February 2023.
- **`@kafkajs/confluent-schema-registry`** — Confluent wire framing and registry
  access, with `SchemaType.PROTOBUF` support and, despite the name, no kafkajs
  dependency.

Protobuf rather than Avro: the `.proto` generates TypeScript types at the
service level (via Buf), so a producer cannot emit a payload that diverges from
the registered schema. Avro gives no compile-time guarantee. `@bufbuild/protobuf`
is a service-level concern — this package stays light and does not depend on it.
