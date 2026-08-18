import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asFunction, createApp, Lifetime } from '@moribashi/core';
import {
  kafkaPlugin,
  KafkaConfigError,
  SchemaRegistrationError,
  type KafkaClient,
  type KafkaProducer,
  type Logger,
  type SchemaRegistryClient,
} from '../index.js';
import { baseConfig, clearKafkaEnv, fakeClient, fakeRegistry } from './helpers.js';

const PROTO = `syntax = "proto3";
package iam;
message IdentityCreated { string id = 1; }
`;

let app: ReturnType<typeof createApp> | undefined;
let tmpDir: string;

const savedEnv = { ...process.env };
const silentLog: Logger = { warn: () => {}, info: () => {} };

beforeEach(async () => {
  clearKafkaEnv();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kafka-plugin-'));
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
  process.env = { ...savedEnv };
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('kafkaPlugin — DI registration', () => {
  it('registers kafkaClient, schemaRegistry and producer', async () => {
    const client = fakeClient();
    app = createApp();
    app.use(kafkaPlugin({ client }));
    await app.start();

    expect(app.resolve<KafkaClient>('kafkaClient')).toBe(client);
    expect(app.resolve<SchemaRegistryClient>('schemaRegistry')).toBe(client.registry);
    expect(typeof app.resolve<KafkaProducer>('producer').send).toBe('function');
  });

  it('resolves producer as a singleton — the same instance every time', async () => {
    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient() }));
    await app.start();

    expect(app.resolve<KafkaProducer>('producer')).toBe(app.resolve<KafkaProducer>('producer'));
  });

  it('gives the producer the plugin-configured client’s registry', async () => {
    // Asserted through the registry rather than a real send: the point is
    // *which* registry the producer resolves subjects against, and no broker
    // is reachable in a unit test.
    const registry = fakeRegistry({
      getLatestSchemaId: vi.fn(async () => {
        throw new Error('sentinel');
      }),
    });
    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient({ ...baseConfig, clientId: 'svc-iam' }, registry) }));
    await app.start();

    await expect(
      app.resolve<KafkaProducer>('producer').send({ topic: 't', value: { id: 'a' } }),
    ).rejects.toThrow(/sentinel/);
    expect(registry.getLatestSchemaId).toHaveBeenCalledWith('t-value');
  });

  it('builds a client from config when none is supplied', async () => {
    app = createApp();
    app.use(kafkaPlugin(baseConfig));
    await app.start();

    expect(app.resolve<KafkaClient>('kafkaClient').config.clientId).toBe('test-service');
  });

  it('builds a client from env when nothing is supplied', async () => {
    process.env.KAFKA_CLIENT_ID = 'env-service';
    process.env.KAFKA_BROKERS = 'redpanda:9092';
    process.env.KAFKA_SCHEMA_REGISTRY_URL = 'http://redpanda:8081';

    app = createApp();
    app.use(kafkaPlugin());
    await app.start();

    expect(app.resolve<KafkaClient>('kafkaClient').config.clientId).toBe('env-service');
  });

  it('fails where the plugin is constructed, not on the first send', () => {
    expect(() => kafkaPlugin({ clientId: 'incomplete' })).toThrow(KafkaConfigError);
  });

  it('carries the plugin name for ordering diagnostics', () => {
    expect(kafkaPlugin({ client: fakeClient() }).name).toBe('@moribashi/kafka');
  });
});

describe('kafkaPlugin — schema registration', () => {
  it('does not register schemas unless asked — registration is producer-scoped', async () => {
    const registry = fakeRegistry();
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), PROTO);

    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient({ ...baseConfig, schemasDir: tmpDir }, registry) }));
    await app.start();

    expect(registry.register).not.toHaveBeenCalled();
  });

  it('registers the configured schemasDir when registerSchemas is true', async () => {
    const registry = fakeRegistry();
    await fs.writeFile(path.join(tmpDir, 'iam.identity.created.v1-value.proto'), PROTO);

    app = createApp();
    app.use(
      kafkaPlugin({
        client: fakeClient({ ...baseConfig, schemasDir: tmpDir }, registry),
        registerSchemas: true,
        log: silentLog,
      }),
    );
    await app.start();

    expect(registry.register).toHaveBeenCalledWith(
      { type: 'PROTOBUF', schema: expect.stringContaining('IdentityCreated') },
      { subject: 'iam.identity.created.v1-value' },
    );
  });

  it('accepts a directory override', async () => {
    const registry = fakeRegistry();
    const other = path.join(tmpDir, 'proto');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'b-value.proto'), PROTO);

    app = createApp();
    app.use(
      kafkaPlugin({
        client: fakeClient({ ...baseConfig, schemasDir: '/nonexistent' }, registry),
        registerSchemas: other,
        log: silentLog,
      }),
    );
    await app.start();

    expect(registry.register).toHaveBeenCalledOnce();
  });

  it('registers before the app finishes starting', async () => {
    const order: string[] = [];
    const registry = fakeRegistry({
      register: vi.fn(async () => {
        order.push('register-schema');
        return { id: 1 };
      }),
    });
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), PROTO);

    app = createApp();
    app.use(
      kafkaPlugin({
        client: fakeClient({ ...baseConfig, schemasDir: tmpDir }, registry),
        registerSchemas: true,
        log: silentLog,
      }),
    );
    app.use({
      name: 'probe',
      register(a) {
        a.container.register({
          probe: asFunction(() => ({
            onInit: () => void order.push('on-init'),
          })).setLifetime(Lifetime.SINGLETON),
        });
      },
    });

    await app.start();

    // Registration is awaited by start() before any singleton is resolved, so
    // a rejected contract is fatal before the service can serve.
    expect(order).toEqual(['register-schema', 'on-init']);
  });

  it('an incompatible schema fails app.start() — the pod crashloops', async () => {
    const registry = fakeRegistry({
      register: vi.fn(async () => {
        throw new Error('incompatible with an earlier schema');
      }),
    });
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), PROTO);

    app = createApp();
    app.use(
      kafkaPlugin({
        client: fakeClient({ ...baseConfig, schemasDir: tmpDir }, registry),
        registerSchemas: true,
        log: silentLog,
      }),
    );

    await expect(app.start()).rejects.toBeInstanceOf(SchemaRegistrationError);
    app = undefined; // never started; nothing to stop
  });

  it('a missing schemas directory does not stop the app', async () => {
    const registry = fakeRegistry();

    app = createApp();
    app.use(
      kafkaPlugin({
        client: fakeClient({ ...baseConfig, schemasDir: path.join(tmpDir, 'gone') }, registry),
        registerSchemas: true,
        log: silentLog,
      }),
    );

    await expect(app.start()).resolves.toBeUndefined();
    expect(registry.register).not.toHaveBeenCalled();
    expect(app.resolve<KafkaProducer>('producer')).toBeDefined();
  });
});

describe('kafkaPlugin — lifecycle', () => {
  it('closes the producer on app.stop() via onDestroy', async () => {
    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient() }));
    await app.start();

    const raw = app.resolve<KafkaProducer>('producer').producer;
    const close = vi.spyOn(raw, 'close');

    await app.stop();
    app = undefined;

    expect(close).toHaveBeenCalledOnce();
  });

  it('leaves the underlying producer closed after stop()', async () => {
    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient() }));
    await app.start();

    const raw = app.resolve<KafkaProducer>('producer').producer;
    await app.stop();
    app = undefined;

    expect(raw.closed).toBe(true);
  });

  it('adds no signal handlers of its own', async () => {
    const before = process.listenerCount('SIGTERM');

    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient() }));
    await app.start();

    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
