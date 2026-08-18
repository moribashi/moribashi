# @moribashi/kafka

Kafka/Redpanda transport as a standard moribashi plugin: connection lifecycle,
DI registration, schema registration at boot, and graceful shutdown through the
app's own lifecycle.

It carries **zero domain knowledge** — no event envelope, no topic naming
convention, no aggregate concepts. Those belong to the service. This package's
job is to get a schema-validated payload onto a topic, hand a decoded one to a
handler, and fail loudly at boot when the contract is wrong.

The producer side mirrors [`@moribashi/pg`](../pg): a framework-free core
(`createKafkaClient()` / `createProducer()`, usable from a plain script) and a
plugin (`kafkaPlugin()`) that registers it into the DI container. The consumer
side is DI-integrated by design — a per-message scope is the point of it — and
ships as a second opt-in plugin, `kafkaConsumerPlugin()`.

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

| Name | Registered by | What it is |
| --- | --- | --- |
| `kafkaClient` | either plugin | Resolved config, `@platformatic/kafka` connection options, the registry client |
| `schemaRegistry` | either plugin | The shared Confluent Schema Registry client |
| `producer` | `kafkaPlugin` | A schema-aware `KafkaProducer` (**singleton**, so `app.stop()` disconnects it) |
| `consumer` | `kafkaConsumerPlugin` | A `KafkaConsumer` (**singleton**; `app.start()` joins the group, `app.stop()` drains and disconnects) |

Use both in one service and they share a single `kafkaClient` — the consumer
plugin reuses whatever `kafkaPlugin` already registered, so there is one place
for broker config to be wrong.

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


## Consuming

```ts
import { createApp } from '@moribashi/core';
import { kafkaConsumerPlugin } from '@moribashi/kafka';

const app = createApp();

app.use(kafkaConsumerPlugin({
  groupId: 'svc-iam',                     // required, no default
  dlq: 'svc-iam.dlq.v1',                  // makes DLQ the failure policy
}));

// Handlers are picked up by convention — same scan as *.svc.ts / *.repo.ts.
await app.scan(['**/*.handler.ts'], { cwd: import.meta.dirname });

await app.start();   // joins the group
// …
await app.stop();    // drains in-flight messages, then disconnects
```

`groupId` is required with no derived default, for the same reason `brokers`
and `clientId` have none: a silently-wrong group id either replays a whole
topic or quietly joins someone else's.

### Handlers bind two ways

**By convention** — a `*.handler.ts` file, discovered by the service's own
`app.scan()` and named by core's usual `formatName` (`identity.handler.ts` →
`identityHandler`). The handler declares the topic it binds to:

```ts
// identity.handler.ts
export default class IdentityHandler implements EventHandler<IdentityCreated> {
  readonly topic = 'iam.identity.created.v1';   // or an array of topics

  constructor({ identityService }: { identityService: IdentityService }) { … }

  async handle(event: EventMessage<IdentityCreated>, scope: EventScope) {
    await this.identityService.mirror(event.value);
  }
}
```

**Explicitly** — a topic → DI-name map in the plugin options:

```ts
app.use(kafkaConsumerPlugin({
  groupId: 'svc-iam',
  handlers: { 'iam.identity.created.v1': 'identityHandler' },
}));
```

Both are on by default. Explicit entries win on conflict. **A topic bound twice
by convention is a startup error**, not last-one-wins: which handler ran would
otherwise depend on filesystem ordering, and the loser would fail silently
forever. `convention: false` turns discovery off; a RegExp narrows it.

Binding is resolved at `onInit`, not at plugin registration, so `app.scan()`
may run after `app.use()`.

Only bound topics are subscribed to — there is no separate `topics` list to
keep in sync.

### The per-message scope

Every message gets its own DI scope, keyed `EVENT_SCOPE`
(`Symbol.for('moribashi.scope.event')`) — the event-side counterpart of
`@moribashi/web`'s request scope. It carries `event` and `correlationId`, and
is disposed once the handler settles.

```ts
app.registerInScope(EVENT_SCOPE, { auditLog: AuditLog });
```

```ts
class AuditLog {
  constructor({ event, correlationId }: EventCradle) { … }
}
```

Type the services you register by merging into `EventCradle`:

```ts
declare module '@moribashi/kafka' {
  interface EventCradle {
    auditLog: AuditLog;
  }
}
```

`correlationId` comes from the `x-correlation-id` header when the producer set
one — the same header the HTTP side uses, so one id spans a request and the
events it causes — and is generated otherwise. Configure the header name with
`correlationIdHeader`.

A **retry gets a fresh scope**, not the message's original one: a handler that
threw halfway may have left scoped services half-applied, and retrying on top of
that is how one bug becomes two.

### Commit semantics: at-least-once

**The offset is committed only after the handler resolves.** Auto-commit is
explicitly disabled (`@platformatic/kafka` defaults it to *on*).

> **Handlers must be idempotent.** A crash, a rebalance, or a failed commit
> between the handler finishing and the offset landing means the message is
> delivered again. That is the deal at-least-once makes; there is no
> configuration that changes it. Key your writes, or upsert.

Ordering is preserved where it matters: messages from one partition are
processed strictly in sequence — that is the whole point of the partition key —
while different partitions run in parallel, bounded by `concurrency`
(default 4).

### When a message cannot be processed

Decode failures and handler throws are treated identically, because both mean
"this message cannot move forward". Before any policy applies, the message is
retried in-process — `maxRetries` (default 3) with exponential backoff
(`retryBackoffMs`, default 250ms, capped by `retryMaxBackoffMs`) — so a
registry blip or a momentary lock timeout never reaches the DLQ. `maxRetries: 0`
disables it.

Then the failure policy runs:

| Policy | What happens |
| --- | --- |
| `{ dlq: 'topic' }` | Republish the original bytes with failure context in headers, commit, advance. **Default when `dlq` is set.** |
| `'skip'` | Count it, log it, commit, advance. Data loss by choice. |
| `'throw'` | Stop consuming and fail loudly. **Default when no DLQ is configured.** |

Skipping is a one-liner:

```ts
app.use(kafkaConsumerPlugin({ groupId: 'svc-iam', failurePolicy: 'skip' }));
```

Logging every skip is on by default (`logSkips: false` for noisy streams), but
the counter always increments. `consumer.stats` exposes
`{ received, processed, retried, skipped, dlq, failed }` for a metrics endpoint.

#### The `'throw'` tradeoff — read this before relying on it

Because commits happen *after* the handler, a throw means the offset is never
committed. Propagating it and carrying on would redeliver the same poison
message forever: an invisible infinite retry that pins a CPU and never advances.

So `'throw'` is defined as **stop consuming**: the run loop ends, in-flight and
queued messages are abandoned rather than committed, `consumer.finished`
rejects, and `onFatal` fires — which by default logs and rethrows on the next
tick so the process dies and the pod restarts.

Abandoning queued work is load-bearing, not tidiness: committing a *later*
offset in the same partition would skip past the uncommitted poison message and
lose it silently.

The partition is wedged either way. `'throw'` at least makes it a loud,
diagnosable outage instead of a silent one — but that is the best a policy
without a DLQ can do, which is why **`{ dlq }` is the better choice as soon as a
service has somewhere to put failures.**

#### DLQ topics must be declared

The cluster runs with `auto_create_topics_enabled: false`, so the DLQ topic has
to exist in the service's `topics:` values like any other. Forgetting it turns
the DLQ path into a *second* failure — which this package treats as fatal
rather than dropping the message silently.

DLQ messages carry the original key and the original bytes, untouched.
Re-encoding something that failed to decode is impossible, and re-encoding a
handler failure would hide what actually arrived. The failure context rides in
headers prefixed `x-moribashi-dlq-`:

| Header | Value |
| --- | --- |
| `x-moribashi-dlq-original-topic` / `-partition` / `-offset` | Where it came from |
| `x-moribashi-dlq-error` / `-error-name` | What went wrong |
| `x-moribashi-dlq-attempts` | Deliveries tried before giving up |
| `x-moribashi-dlq-group-id` | Which consumer group gave up |
| `x-moribashi-dlq-timestamp` | When |

### Consumers never register schemas

Decoding reads the schema id out of the Confluent framing and looks it up —
a read, not a registration. `registerSchemas` is a producer-side option and has
no consumer equivalent, deliberately: a consumer that registered a schema would
be asserting a contract it does not own.

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

- `producer.producer` / `consumer.consumer` — the underlying
  `@platformatic/kafka` clients.
- `createKafkaClient(existingClient)` — BYO client, detected structurally.
- `createProducer({ producer })` / `createConsumer({ consumer, dlqProducer })` —
  BYO `@platformatic/kafka` instances.
- `registerSchemas({ registry })` — BYO Schema Registry client.
- `resolveHandlerBindings({ app, … })` — the binding resolution on its own.

## No signal handlers

This package registers no `SIGTERM`/`SIGINT` handlers and never calls
`process.exit()` — the one exception being the default `onFatal`, which
deliberately rethrows so a wedged consumer cannot look healthy. Disconnection is
`producer.onDestroy()` / `consumer.onDestroy()`, fired by `app.stop()` in reverse
initialization order; the consumer waits for handlers already running before it
closes. A transport library racing the service's own shutdown is a source of
dropped in-flight messages, not a feature.

## Local development

```sh
docker compose -f packages/kafka/docker-compose.yml up -d
KAFKA_INTEGRATION=1 pnpm --filter @moribashi/kafka run test
docker compose -f packages/kafka/docker-compose.yml down -v
```

Single-node Redpanda plus Console on <http://localhost:8080>. The integration
suite is skipped unless `KAFKA_INTEGRATION=1`; it is the only place the real
Confluent wire format, a real produce → consume → decode → commit round-trip,
and a real DLQ hop are exercised end to end.

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
