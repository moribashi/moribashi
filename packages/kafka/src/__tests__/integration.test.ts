/**
 * End-to-end suite against a real Redpanda + Schema Registry.
 *
 * Skipped unless `KAFKA_INTEGRATION=1`, because it needs a broker:
 *
 *   docker compose -f packages/kafka/docker-compose.yml up -d
 *   KAFKA_INTEGRATION=1 pnpm --filter @moribashi/kafka run test
 *
 * The unit suites fake the registry, so this is the only place the actual
 * Confluent wire format — magic byte, schema id, protobuf message-index
 * varints — is exercised. That framing is exactly what this package refuses
 * to hand-roll, so it is worth proving the library really produces something
 * a consumer can decode.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Admin, Consumer, Producer } from '@platformatic/kafka';
import { createApp } from '@moribashi/core';
import {
  checkSchemaCompatibility,
  createKafkaClient,
  kafkaConsumerPlugin,
  kafkaPlugin,
  registerSchemas,
  DLQ_HEADER_PREFIX,
  EVENT_SCOPE,
  SchemaRegistrationError,
  type EventMessage,
  type KafkaClient,
  type KafkaConsumer,
  type KafkaProducer,
  type Logger,
} from '../index.js';

const enabled = process.env.KAFKA_INTEGRATION === '1';

const brokers = (process.env.KAFKA_BROKERS ?? 'redpanda:9092').split(',');
const registryUrl = process.env.KAFKA_SCHEMA_REGISTRY_URL ?? 'http://redpanda:8081';

const TOPIC = `moribashi.kafka.it.${Date.now()}.v1`;
const SUBJECT = `${TOPIC}-value`;
const DLQ_TOPIC = `${TOPIC}.dlq`;

const V1 = `syntax = "proto3";
package moribashi.it;
message IdentityCreated {
  string id = 1;
  string email = 2;
}
`;

/** Adds an optional field — backwards compatible. */
const V2_COMPATIBLE = `syntax = "proto3";
package moribashi.it;
message IdentityCreated {
  string id = 1;
  string email = 2;
  string display_name = 3;
}
`;

const silentLog: Logger = { warn: () => {}, info: () => {} };

let tmpDir: string;
let client: KafkaClient;
let admin: Admin;

async function writeSchema(dir: string, body: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${SUBJECT}.proto`), body);
  return dir;
}

describe.skipIf(!enabled)('integration: Redpanda + Schema Registry', () => {
  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kafka-it-'));
    client = createKafkaClient({
      clientId: 'moribashi-kafka-it',
      brokers,
      schemaRegistry: { url: registryUrl },
      schemasDir: tmpDir,
    });

    admin = new Admin({ clientId: 'moribashi-kafka-it-admin', bootstrapBrokers: brokers });
    await admin.createTopics({ topics: [TOPIC], partitions: 6, replicas: 1 });
    // The cluster does not auto-create topics, so the DLQ must be declared
    // just like any other topic a service depends on.
    await admin.createTopics({ topics: [DLQ_TOPIC], partitions: 1, replicas: 1 });
  }, 60_000);

  afterAll(async () => {
    await admin?.deleteTopics({ topics: [TOPIC, DLQ_TOPIC] }).catch(() => {});
    await admin?.close();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  }, 60_000);

  it('registers a .proto and gets a real schema id back', async () => {
    await writeSchema(tmpDir, V1);

    const [registered] = await registerSchemas({ client, log: silentLog });

    expect(registered.subject).toBe(SUBJECT);
    expect(registered.id).toBeGreaterThan(0);
  });

  it('re-registering the same schema returns the same id — idempotent, no ledger', async () => {
    const [first] = await registerSchemas({ client, log: silentLog });
    const [second] = await registerSchemas({ client, log: silentLog });

    expect(second.id).toBe(first.id);
  });

  it('accepts a backwards-compatible change with a new id', async () => {
    const [before] = await registerSchemas({ client, log: silentLog });

    await writeSchema(tmpDir, V2_COMPATIBLE);
    const [after] = await registerSchemas({ client, log: silentLog });

    expect(after.id).not.toBe(before.id);
  });

  it('reports compatibility without registering', async () => {
    const [result] = await checkSchemaCompatibility({ client, log: silentLog });

    expect(result).toMatchObject({ subject: SUBJECT, compatible: true });
  });

  it('produces a keyed message a plain consumer can decode', async () => {
    const app = createApp();
    app.use(kafkaPlugin({ client, registerSchemas: true, log: silentLog }));
    await app.start();

    const producer = app.resolve<KafkaProducer>('producer');
    await producer.send([
      { topic: TOPIC, value: { id: 'a1', email: 'a@example.com' }, key: 'tenant-a' },
      { topic: TOPIC, value: { id: 'b1', email: 'b@example.com' }, key: 'tenant-b' },
    ]);

    const consumer = new Consumer({
      clientId: 'moribashi-kafka-it-consumer',
      bootstrapBrokers: brokers,
      groupId: `moribashi-kafka-it-${Date.now()}`,
      autocreateTopics: false,
    });

    const stream = await consumer.consume({ topics: [TOPIC], mode: 'earliest' });
    const seen: Array<{ key: string; value: Record<string, unknown> }> = [];

    for await (const message of stream) {
      seen.push({
        key: message.key.toString(),
        // Decoding proves the Confluent framing this package produced is the
        // real thing — the registry resolves the schema id out of the bytes.
        value: (await client.registry.decode(message.value)) as Record<string, unknown>,
      });
      if (seen.length === 2) break;
    }

    await stream.close();
    await consumer.close();
    await app.stop();

    expect(seen.map(s => s.key).sort()).toEqual(['tenant-a', 'tenant-b']);
    expect(seen.map(s => s.value.id).sort()).toEqual(['a1', 'b1']);
  }, 60_000);

  it('rejects an incompatible change loudly', async () => {
    const incompatibleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kafka-it-bad-'));
    // Removing a field and changing a field type breaks the reader contract.
    await writeSchema(
      incompatibleDir,
      `syntax = "proto3";
package moribashi.it;
message IdentityCreated {
  int32 id = 1;
}
`,
    );

    try {
      await expect(
        registerSchemas({ client, dir: incompatibleDir, log: silentLog }),
      ).rejects.toBeInstanceOf(SchemaRegistrationError);
    } finally {
      await fs.rm(incompatibleDir, { recursive: true, force: true });
    }
  });


  describe('consumer round-trip', () => {
    /** Polls until `check` is true, so tests do not race the broker. */
    async function until(check: () => boolean, timeoutMs = 30_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    async function committedOffsets(groupId: string, topic: string): Promise<bigint[]> {
      const [group] = await admin.listConsumerGroupOffsets({ groups: [groupId] });
      const entry = group?.topics.find(t => t.name === topic);
      return (entry?.partitions ?? [])
        .map(p => p.committedOffset)
        .filter(offset => offset >= 0n);
    }

    it('produces, consumes, decodes and commits', async () => {
      const groupId = `moribashi-kafka-it-rt-${Date.now()}`;
      const seen: Array<{ key?: string; value: Record<string, unknown>; correlationId: string }> = [];

      const producerApp = createApp();
      producerApp.use(kafkaPlugin({ client, registerSchemas: true, log: silentLog }));
      await producerApp.start();
      await producerApp.resolve<KafkaProducer>('producer').send([
        {
          topic: TOPIC,
          key: 'tenant-a',
          value: { id: 'rt-a', email: 'a@example.com' },
          headers: { 'x-correlation-id': 'corr-rt-a' },
        },
        { topic: TOPIC, key: 'tenant-b', value: { id: 'rt-b', email: 'b@example.com' } },
      ]);
      await producerApp.stop();

      const consumerApp = createApp();
      consumerApp.use(
        kafkaConsumerPlugin({
          client,
          groupId,
          convention: false,
          mode: 'earliest',
          log: silentLog,
          handlers: {
            [TOPIC]: (event: EventMessage) => {
              seen.push({
                key: event.key,
                value: event.value as Record<string, unknown>,
                correlationId: event.correlationId,
              });
            },
          },
        }),
      );
      const isMine = (id: unknown) => id === 'rt-a' || id === 'rt-b';

      await consumerApp.start();
      // A fresh group reading from earliest also replays whatever earlier
      // tests left on the topic, so wait for *these* two specifically.
      await until(() => seen.filter(s => isMine(s.value.id)).length >= 2);
      await consumerApp.stop();

      const mine = seen.filter(s => isMine(s.value.id));
      expect(mine.map(s => s.key).sort()).toEqual(['tenant-a', 'tenant-b']);
      expect(mine.map(s => s.value.id).sort()).toEqual(['rt-a', 'rt-b']);
      // The correlation id rode across the produce → consume hop.
      expect(mine.find(s => s.value.id === 'rt-a')!.correlationId).toBe('corr-rt-a');
      // …and one was generated for the message that carried no header.
      expect(mine.find(s => s.value.id === 'rt-b')!.correlationId).toMatch(/^[0-9a-f-]{36}$/);

      // Commit-after-handler moved the group's offsets for every message the
      // handler resolved on — no more, no less.
      const offsets = await committedOffsets(groupId, TOPIC);
      expect(offsets.reduce((a, b) => a + b, 0n)).toBe(BigInt(seen.length));
    }, 90_000);

    it('resolves scoped services per message', async () => {
      const groupId = `moribashi-kafka-it-scope-${Date.now()}`;
      const offsets: string[] = [];

      class EventAudit {
        readonly event: EventMessage;
        constructor({ event }: { event: EventMessage }) {
          this.event = event;
        }
      }

      const producerApp = createApp();
      producerApp.use(kafkaPlugin({ client, log: silentLog }));
      await producerApp.start();
      await producerApp
        .resolve<KafkaProducer>('producer')
        .send({ topic: TOPIC, key: 'tenant-c', value: { id: 'scoped', email: 'c@example.com' } });
      await producerApp.stop();

      const consumerApp = createApp();
      consumerApp.registerInScope(EVENT_SCOPE, { eventAudit: EventAudit });
      consumerApp.use(
        kafkaConsumerPlugin({
          client,
          groupId,
          convention: false,
          mode: 'earliest',
          log: silentLog,
          handlers: {
            [TOPIC]: (_event, scope) => {
              offsets.push(String(scope.resolve<EventAudit>('eventAudit').event.offset));
            },
          },
        }),
      );
      await consumerApp.start();
      await until(() => offsets.length >= 1);
      await consumerApp.stop();

      expect(offsets.length).toBeGreaterThan(0);
    }, 90_000);

    it('routes a poison message to a real DLQ topic and advances past it', async () => {
      const groupId = `moribashi-kafka-it-dlq-${Date.now()}`;

      // Raw, unframed bytes: no magic byte, no schema id. Nothing can decode
      // this, which is exactly the poison case a DLQ exists for.
      const poison = Buffer.from('this is not confluent-framed protobuf');
      const rawProducer = new Producer<Buffer, Buffer, string, string>({
        clientId: 'moribashi-kafka-it-poison',
        bootstrapBrokers: brokers,
        autocreateTopics: false,
        serializers: {
          key: (d?: Buffer) => d,
          value: (d?: Buffer) => d,
          headerKey: (d?: string) => (d === undefined ? undefined : Buffer.from(d)),
          headerValue: (d?: string) => (d === undefined ? undefined : Buffer.from(d)),
        },
      });
      await rawProducer.send({
        messages: [
          { topic: TOPIC, partition: 0, key: Buffer.from('tenant-poison'), value: poison },
        ],
      });
      await rawProducer.close();

      let dlqRouted = 0;
      const consumerApp = createApp();
      consumerApp.use(
        kafkaConsumerPlugin({
          client,
          groupId,
          convention: false,
          mode: 'earliest',
          dlq: DLQ_TOPIC,
          maxRetries: 1,
          log: {
            warn: () => {},
            info: () => {},
            error: (_obj, msg) => {
              if (msg.includes('DLQ')) dlqRouted++;
            },
          },
          handlers: { [TOPIC]: () => {} },
        }),
      );
      await consumerApp.start();
      const consumer = consumerApp.resolve<KafkaConsumer>('consumer');
      await until(() => consumer.stats.dlq >= 1);
      await consumerApp.stop();

      expect(dlqRouted).toBeGreaterThan(0);
      expect(consumer.stats.dlq).toBe(1);

      // Read the DLQ topic with a plain consumer — the bytes and the failure
      // context must be there for a human to replay.
      const dlqReader = new Consumer<Buffer, Buffer, string, string>({
        clientId: 'moribashi-kafka-it-dlq-reader',
        bootstrapBrokers: brokers,
        groupId: `${groupId}-reader`,
        autocreateTopics: false,
        deserializers: {
          key: (d?: Buffer) => d,
          value: (d?: Buffer) => d,
          headerKey: (d?: Buffer) => d?.toString('utf8'),
          headerValue: (d?: Buffer) => d?.toString('utf8'),
        },
      });
      const dlqStream = await dlqReader.consume({
        topics: [DLQ_TOPIC],
        mode: 'earliest',
        autocommit: false,
      });

      let received: { value: Buffer; key?: Buffer; headers: Map<string, string> } | undefined;
      for await (const message of dlqStream) {
        received = message;
        break;
      }
      await dlqStream.close();
      await dlqReader.close();

      expect(received!.value.equals(poison)).toBe(true);
      expect(received!.key?.toString()).toBe('tenant-poison');
      const headers = Object.fromEntries(received!.headers);
      expect(headers[`${DLQ_HEADER_PREFIX}original-topic`]).toBe(TOPIC);
      expect(headers[`${DLQ_HEADER_PREFIX}original-partition`]).toBe('0');
      expect(headers[`${DLQ_HEADER_PREFIX}attempts`]).toBe('2');
      expect(headers[`${DLQ_HEADER_PREFIX}error-name`]).toBe('SchemaDecodeError');
      expect(headers[`${DLQ_HEADER_PREFIX}group-id`]).toBe(groupId);

      // The partition advanced: the poison message was committed after being
      // routed, so a restart does not replay it forever.
      const offsets = await committedOffsets(groupId, TOPIC);
      expect(offsets.reduce((a, b) => a + b, 0n)).toBeGreaterThan(0n);
    }, 120_000);
  });

  it('refuses to produce to an unknown topic — auto-creation is off', async () => {
    const app = createApp();
    app.use(kafkaPlugin({ client }));
    await app.start();

    await expect(
      app
        .resolve<KafkaProducer>('producer')
        .send({ topic: `${TOPIC}.does-not-exist`, value: { id: 'x' } }),
    ).rejects.toBeTruthy();

    await app.stop();
  }, 60_000);
});
