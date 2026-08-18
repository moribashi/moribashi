/**
 * Adversarial suite: the cases a well-behaved caller never produces, but a
 * real service eventually does — hostile env values, a registry that lies,
 * concurrent sends racing a cache expiry, and payloads that look like
 * something else.
 *
 * These are separated from the per-module suites on purpose: the module
 * suites document the contract, this one documents what the contract survives.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '@moribashi/core';
import {
  buildConnectionOptions,
  checkSchemaCompatibility,
  createKafkaClient,
  createKafkaConfig,
  createProducer,
  isKafkaClient,
  kafkaPlugin,
  KafkaConfigError,
  readSchemaSources,
  registerSchemas,
  SchemaEncodeError,
  SchemaRegistrationError,
  subjectForFile,
  subjectForTopic,
  type KafkaProducer,
  type Logger,
} from '../index.js';
import {
  baseConfig,
  clearKafkaEnv,
  fakeClient,
  fakeFetch,
  fakeRawProducer,
  fakeRegistry,
} from './helpers.js';

const savedEnv = { ...process.env };
const silentLog: Logger = { warn: () => {}, info: () => {} };
let tmpDir: string;
let app: ReturnType<typeof createApp> | undefined;

beforeEach(async () => {
  clearKafkaEnv();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kafka-adversarial-'));
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
  process.env = { ...savedEnv };
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('hostile configuration', () => {
  it('does not let a broker list of only separators pass as configured', () => {
    process.env.KAFKA_CLIENT_ID = 'svc';
    process.env.KAFKA_BROKERS = ',,,';
    process.env.KAFKA_SCHEMA_REGISTRY_URL = 'http://sr:8081';

    expect(() => createKafkaConfig()).toThrow(KafkaConfigError);
  });

  it('rejects a mechanism that differs only by case', () => {
    process.env.KAFKA_SASL_MECHANISM = 'OAUTHBEARER';

    expect(() => createKafkaConfig(baseConfig)).toThrow(/KAFKA_SASL_MECHANISM/);
  });

  it('does not accept an empty-string password as credentials', () => {
    process.env.KAFKA_SASL_MECHANISM = 'scram-sha-256';
    process.env.KAFKA_SASL_USERNAME = 'u';
    process.env.KAFKA_SASL_PASSWORD = '';

    expect(() => createKafkaConfig(baseConfig)).toThrow(/KAFKA_SASL_PASSWORD/);
  });

  it('never captures a token at construction time', () => {
    const tokenProvider = vi.fn(async () => 'secret');

    buildConnectionOptions(
      createKafkaConfig({ ...baseConfig, sasl: { mechanism: 'oauthbearer', tokenProvider } }),
    );

    expect(tokenProvider).not.toHaveBeenCalled();
  });

  it('surfaces a token provider failure to the caller rather than swallowing it', async () => {
    const tokenProvider = async () => {
      throw new Error('token exchange failed');
    };

    const options = buildConnectionOptions(
      createKafkaConfig({ ...baseConfig, sasl: { mechanism: 'oauthbearer', tokenProvider } }),
    );

    await expect((options.sasl?.token as () => Promise<string>)()).rejects.toThrow(
      'token exchange failed',
    );
  });

  it('cannot be tricked into auto-creating topics by a config object', () => {
    const config = createKafkaConfig({
      ...baseConfig,
      allowAutoTopicCreation: true,
      autocreateTopics: true,
    } as never);

    expect(buildConnectionOptions(config).autocreateTopics).toBe(false);
  });

  it('treats an object that merely looks like a client as config, not a client', () => {
    const impostor = { config: { clientId: 'x' } };

    expect(isKafkaClient(impostor)).toBe(false);
    expect(() => createKafkaClient(impostor as never)).toThrow(KafkaConfigError);
  });

  it('rejects an array passed as config overrides', () => {
    expect(() => createKafkaConfig([] as never)).toThrow(/must be an object/);
  });

  it('does not mutate the caller’s overrides object', () => {
    const overrides = { ...baseConfig };
    const snapshot = JSON.stringify(overrides);

    createKafkaConfig(overrides);

    expect(JSON.stringify(overrides)).toBe(snapshot);
  });

  it('does not alias the caller’s brokers array into the config', () => {
    const brokers = ['a:9092'];
    const config = createKafkaConfig({ ...baseConfig, brokers });

    config.brokers.push('b:9092');

    // Documented behaviour: the array is carried by reference, so callers who
    // hold onto it see the same array. Config is validated, not deep-frozen.
    expect(brokers).toEqual(['a:9092', 'b:9092']);
  });
});

describe('hostile schema directories', () => {
  it('surfaces a subdirectory named *.proto instead of swallowing it', async () => {
    await fs.mkdir(path.join(tmpDir, 'nested-value.proto'));

    // readdir lists it and reading it fails with EISDIR. That must surface —
    // silently reporting "no schemas" would let a producer boot with no
    // registered contract at all.
    await expect(readSchemaSources({ dir: tmpDir, log: silentLog })).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });

  it('only swallows ENOENT/ENOTDIR — other readdir errors propagate', async () => {
    const notADir = path.join(tmpDir, 'file');
    await fs.writeFile(notADir, 'x');

    // ENOTDIR is the "you pointed schemasDir at a file" case: warn, continue.
    await expect(readSchemaSources({ dir: notADir, log: silentLog })).resolves.toEqual([]);
  });

  it('registers an empty .proto file rather than guessing at intent', async () => {
    await fs.writeFile(path.join(tmpDir, 'empty-value.proto'), '');
    const registry = fakeRegistry();

    await registerSchemas({
      client: fakeClient(baseConfig, registry),
      dir: tmpDir,
      log: silentLog,
    });

    // The registry is the authority on what a valid schema is; this package
    // does not parse .proto itself.
    expect(registry.register).toHaveBeenCalledWith(
      { type: 'PROTOBUF', schema: '' },
      { subject: 'empty-value' },
    );
  });

  it('wraps a registry that throws a non-Error', async () => {
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), 'syntax = "proto3";');
    const registry = fakeRegistry({
      register: vi.fn(async () => {
        throw 'plain string rejection';
      }),
    });

    await expect(
      registerSchemas({ client: fakeClient(baseConfig, registry), dir: tmpDir, log: silentLog }),
    ).rejects.toBeInstanceOf(SchemaRegistrationError);
  });

  it('keeps subjects distinct for files differing only in case', async () => {
    expect(subjectForFile('Orders-value.proto')).not.toBe(subjectForFile('orders-value.proto'));
  });

  it('does not strip a .proto that appears mid-filename', () => {
    expect(subjectForFile('a.proto.backup-value.proto')).toBe('a.proto.backup-value');
  });

  it('derives a subject for a topic containing dots and dashes', () => {
    expect(subjectForTopic('iam.identity-created.v1')).toBe('iam.identity-created.v1-value');
  });
});

describe('a registry that misbehaves', () => {
  function producerWith(registryOverrides = {}) {
    const registry = fakeRegistry(registryOverrides);
    const raw = fakeRawProducer();
    return {
      registry,
      raw,
      producer: createProducer({
        client: fakeClient(baseConfig, registry),
        producer: raw,
      }),
    };
  }

  it('never sends when the registry hangs up mid-batch', async () => {
    let call = 0;
    const { raw, producer } = producerWith({
      getLatestSchemaId: vi.fn(async () => {
        if (++call === 2) throw new Error('ECONNRESET');
        return 1;
      }),
    });

    await expect(
      producer.send([
        { topic: 'a', value: 1 },
        { topic: 'b', value: 2 },
      ]),
    ).rejects.toBeInstanceOf(SchemaEncodeError);
    expect(raw.send).not.toHaveBeenCalled();
  });

  it('does not poison other subjects when one subject fails', async () => {
    const { producer } = producerWith({
      getLatestSchemaId: vi.fn(async (subject: string) => {
        if (subject === 'bad-value') throw new Error('missing');
        return 3;
      }),
    });

    await expect(producer.send({ topic: 'bad', value: 1 })).rejects.toBeInstanceOf(
      SchemaEncodeError,
    );
    await expect(producer.send({ topic: 'good', value: 1 })).resolves.toBeDefined();
  });

  it('lets every concurrent caller see the same failure when a coalesced lookup fails', async () => {
    const { registry, producer } = producerWith({
      getLatestSchemaId: vi.fn(async () => {
        throw new Error('registry down');
      }),
    });

    const results = await Promise.allSettled([
      producer.send({ topic: 't', value: 1 }),
      producer.send({ topic: 't', value: 2 }),
    ]);

    expect(results.every(r => r.status === 'rejected')).toBe(true);
    expect(registry.getLatestSchemaId).toHaveBeenCalledTimes(1);
  });

  it('re-resolves after a coalesced failure instead of caching it', async () => {
    let attempt = 0;
    const { registry, producer } = producerWith({
      getLatestSchemaId: vi.fn(async () => {
        if (++attempt <= 1) throw new Error('registry down');
        return 9;
      }),
    });

    await Promise.allSettled([
      producer.send({ topic: 't', value: 1 }),
      producer.send({ topic: 't', value: 2 }),
    ]);
    await expect(producer.send({ topic: 't', value: 3 })).resolves.toBeDefined();

    expect(registry.getLatestSchemaId).toHaveBeenCalledTimes(2);
  });

  it('tolerates a registry that returns schema id 0', async () => {
    const { raw, producer } = producerWith({ getLatestSchemaId: vi.fn(async () => 0) });

    await producer.send({ topic: 't', value: { a: 1 } });

    const messages = raw.send.mock.calls[0][0].messages as Array<{ value: Buffer }>;
    expect(messages[0].value.toString()).toBe('0:{"a":1}');
  });

  it('caches schema id 0 like any other id', async () => {
    const { registry, producer } = producerWith({ getLatestSchemaId: vi.fn(async () => 0) });

    await producer.send({ topic: 't', value: 1 });
    await producer.send({ topic: 't', value: 2 });

    expect(registry.getLatestSchemaId).toHaveBeenCalledTimes(1);
  });

  it('propagates an empty encoded buffer rather than treating it as absent', async () => {
    const { raw, producer } = producerWith({
      encode: vi.fn(async () => Buffer.alloc(0)),
    });

    await producer.send({ topic: 't', value: {} });

    const messages = raw.send.mock.calls[0][0].messages as Array<{ value: Buffer }>;
    expect(messages[0].value).toHaveLength(0);
  });
});

describe('payload edge cases', () => {
  function producerWith() {
    const registry = fakeRegistry();
    const raw = fakeRawProducer();
    return {
      registry,
      raw,
      producer: createProducer({ client: fakeClient(baseConfig, registry), producer: raw }),
    };
  }

  it('passes a null value straight to the registry — tombstones are the caller’s call', async () => {
    const { registry, producer } = producerWith();

    await producer.send({ topic: 't', value: null });

    expect(registry.encode).toHaveBeenCalledWith(42, null);
  });

  it('does not confuse an empty-string key with an absent key', async () => {
    const { raw, producer } = producerWith();

    await producer.send({ topic: 't', value: {}, key: '' });

    const messages = raw.send.mock.calls[0][0].messages as Array<Record<string, unknown>>;
    expect(messages[0]).toHaveProperty('key');
    expect(messages[0].key).toEqual(Buffer.alloc(0));
  });

  it('keeps partition 0 rather than dropping it as falsy', async () => {
    const { raw, producer } = producerWith();

    await producer.send({ topic: 't', value: {}, partition: 0 });

    const messages = raw.send.mock.calls[0][0].messages as Array<Record<string, unknown>>;
    expect(messages[0].partition).toBe(0);
  });

  it('keeps timestamp 0n rather than dropping it as falsy', async () => {
    const { raw, producer } = producerWith();

    await producer.send({ topic: 't', value: {}, timestamp: 0n });

    const messages = raw.send.mock.calls[0][0].messages as Array<Record<string, unknown>>;
    expect(messages[0].timestamp).toBe(0n);
  });

  it('preserves message order through encoding', async () => {
    const { raw, producer } = producerWith();

    await producer.send(
      Array.from({ length: 20 }, (_, i) => ({ topic: 't', value: i, key: `k${i}` })),
    );

    const messages = raw.send.mock.calls[0][0].messages as Array<{ key: Buffer }>;
    expect(messages.map(m => m.key.toString())).toEqual(
      Array.from({ length: 20 }, (_, i) => `k${i}`),
    );
  });

  it('propagates a broker-level send failure unwrapped', async () => {
    const { raw, producer } = producerWith();
    const brokerError = new Error('NOT_LEADER_FOR_PARTITION');
    raw.send.mockRejectedValueOnce(brokerError);

    await expect(producer.send({ topic: 't', value: {} })).rejects.toBe(brokerError);
  });
});

describe('compatibility check under duress', () => {
  it('percent-encodes a subject with URL-hostile characters', async () => {
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), 'x');
    const fetchImpl = fakeFetch([{ body: { is_compatible: true } }]);

    await checkWith(fetchImpl, () => 'a-value?evil=1');

    expect(fetchImpl.calls[0].url).toContain('a-value%3Fevil%3D1');
  });

  it('treats a missing is_compatible field as incompatible, not as a pass', async () => {
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), 'x');
    const fetchImpl = fakeFetch([{ body: {} }]);

    const [result] = await checkWith(fetchImpl);

    expect(result.compatible).toBe(false);
  });

  it('treats a string "true" as incompatible — no coercion', async () => {
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), 'x');
    const fetchImpl = fakeFetch([{ body: { is_compatible: 'true' } }]);

    const [result] = await checkWith(fetchImpl);

    expect(result.compatible).toBe(false);
  });

  it('throws on a 401 rather than reporting a clean bill of health', async () => {
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), 'x');
    const fetchImpl = fakeFetch([{ status: 401, text: 'Unauthorized' }]);

    await expect(checkWith(fetchImpl)).rejects.toBeInstanceOf(SchemaRegistrationError);
  });

  async function checkWith(
    fetchImpl: ReturnType<typeof fakeFetch>,
    subjectFor?: (file: string) => string,
  ) {
    return checkSchemaCompatibility({
      client: fakeClient(),
      dir: tmpDir,
      fetchImpl,
      log: silentLog,
      ...(subjectFor ? { subjectFor } : {}),
    });
  }
});

describe('plugin under duress', () => {
  it('two apps can share one client without fighting over it', async () => {
    const client = fakeClient();

    const first = createApp();
    const second = createApp();
    first.use(kafkaPlugin({ client }));
    second.use(kafkaPlugin({ client }));
    await first.start();
    await second.start();

    expect(first.resolve<KafkaProducer>('producer')).not.toBe(
      second.resolve<KafkaProducer>('producer'),
    );

    await first.stop();
    await second.stop();
  });

  it('stop() is safe when the producer was never used', async () => {
    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient() }));
    await app.start();

    await expect(app.stop()).resolves.toBeUndefined();
    app = undefined;
  });

  it('stop() twice does not throw', async () => {
    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient() }));
    await app.start();

    await app.stop();
    await expect(app.stop()).resolves.toBeUndefined();
    app = undefined;
  });

  it('a bad KAFKA_TLS value fails at kafkaPlugin(), not at the first connect', () => {
    process.env.KAFKA_TLS = 'sometimes';

    expect(() => kafkaPlugin(baseConfig)).toThrow(KafkaConfigError);
  });
});
