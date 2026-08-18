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
import { Admin, Consumer } from '@platformatic/kafka';
import { createApp } from '@moribashi/core';
import {
  checkSchemaCompatibility,
  createKafkaClient,
  kafkaPlugin,
  registerSchemas,
  SchemaRegistrationError,
  type KafkaClient,
  type KafkaProducer,
  type Logger,
} from '../index.js';

const enabled = process.env.KAFKA_INTEGRATION === '1';

const brokers = (process.env.KAFKA_BROKERS ?? 'redpanda:9092').split(',');
const registryUrl = process.env.KAFKA_SCHEMA_REGISTRY_URL ?? 'http://redpanda:8081';

const TOPIC = `moribashi.kafka.it.${Date.now()}.v1`;
const SUBJECT = `${TOPIC}-value`;

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
  }, 60_000);

  afterAll(async () => {
    await admin?.deleteTopics({ topics: [TOPIC] }).catch(() => {});
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
