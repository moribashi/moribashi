import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createProducer, SchemaEncodeError } from '../index.js';
import {
  baseConfig,
  clearKafkaEnv,
  fakeClient,
  fakeRawProducer,
  fakeRegistry,
  type RegistryStubs,
} from './helpers.js';

const savedEnv = { ...process.env };

beforeEach(() => {
  clearKafkaEnv();
});

afterEach(() => {
  process.env = { ...savedEnv };
});

function setup(
  registryOverrides: Partial<RegistryStubs> = {},
  producerOptions: Parameters<typeof createProducer>[0] = {},
) {
  const registry = fakeRegistry(registryOverrides);
  const raw = fakeRawProducer();
  const producer = createProducer({
    client: fakeClient(baseConfig, registry),
    producer: raw,
    ...producerOptions,
  });
  return { registry, raw, producer };
}

/** The messages handed to the underlying producer by the last send(). */
function sentMessages(raw: ReturnType<typeof fakeRawProducer>) {
  return raw.send.mock.calls.at(-1)?.[0].messages as Array<Record<string, unknown>>;
}

describe('createProducer', () => {
  it('exposes the underlying producer as an escape hatch', () => {
    const { raw, producer } = setup();
    expect(producer.producer).toBe(raw);
  });

  it('builds a real @platformatic/kafka producer when none is supplied', async () => {
    const producer = createProducer({ client: fakeClient() });

    expect(producer.producer).toBeDefined();
    expect(typeof producer.producer.send).toBe('function');
    await producer.close();
  });

  it('validates config eagerly when given overrides', () => {
    expect(() => createProducer({ client: { clientId: 'only-this' } })).toThrow(
      /KAFKA_BROKERS/,
    );
  });
});

describe('send', () => {
  it('encodes the value against the topic subject and produces it', async () => {
    const { registry, raw, producer } = setup();

    await producer.send({ topic: 'iam.identity.created.v1', value: { id: 'a1' } });

    expect(registry.getLatestSchemaId).toHaveBeenCalledWith('iam.identity.created.v1-value');
    expect(registry.encode).toHaveBeenCalledWith(42, { id: 'a1' });
    expect(sentMessages(raw)).toEqual([
      { topic: 'iam.identity.created.v1', value: Buffer.from('42:{"id":"a1"}') },
    ]);
  });

  it('accepts a single message or an array', async () => {
    const { raw, producer } = setup();

    await producer.send({ topic: 't', value: 1 });
    await producer.send([{ topic: 't', value: 2 }]);

    expect(raw.send).toHaveBeenCalledTimes(2);
    expect(sentMessages(raw)).toHaveLength(1);
  });

  it('short-circuits an empty batch without touching the broker', async () => {
    const { registry, raw, producer } = setup();

    await expect(producer.send([])).resolves.toEqual({ offsets: [] });

    expect(raw.send).not.toHaveBeenCalled();
    expect(registry.encode).not.toHaveBeenCalled();
  });

  it('returns the underlying produce result', async () => {
    const result = { offsets: [{ topic: 't', partition: 0, offset: 5n }] };
    const { producer, raw } = setup();
    raw.send.mockResolvedValueOnce(result);

    await expect(producer.send({ topic: 't', value: {} })).resolves.toBe(result);
  });

  describe('keys are per message, not per batch', () => {
    it('carries a distinct key for every message in one batch', async () => {
      const { raw, producer } = setup();

      await producer.send([
        { topic: 't', value: { id: 'a' }, key: 'tenant-a' },
        { topic: 't', value: { id: 'b' }, key: 'tenant-b' },
        { topic: 't', value: { id: 'c' }, key: 'tenant-c' },
      ]);

      expect(sentMessages(raw).map(m => (m.key as Buffer).toString())).toEqual([
        'tenant-a',
        'tenant-b',
        'tenant-c',
      ]);
    });

    it('UTF-8 encodes a string key', async () => {
      const { raw, producer } = setup();

      await producer.send({ topic: 't', value: {}, key: 'ключ' });

      expect(sentMessages(raw)[0].key).toEqual(Buffer.from('ключ', 'utf8'));
    });

    it('passes a Buffer key through untouched', async () => {
      const key = Buffer.from([0xde, 0xad]);
      const { raw, producer } = setup();

      await producer.send({ topic: 't', value: {}, key });

      expect(sentMessages(raw)[0].key).toBe(key);
    });

    it('omits the key entirely when none is given', async () => {
      const { raw, producer } = setup();

      await producer.send({ topic: 't', value: {} });

      expect(sentMessages(raw)[0]).not.toHaveProperty('key');
    });

    it('lets some messages be keyed and others not', async () => {
      const { raw, producer } = setup();

      await producer.send([
        { topic: 't', value: 1, key: 'k' },
        { topic: 't', value: 2 },
      ]);

      const messages = sentMessages(raw);
      expect(messages[0].key).toEqual(Buffer.from('k'));
      expect(messages[1]).not.toHaveProperty('key');
    });
  });

  it('passes headers, partition and timestamp through per message', async () => {
    const { raw, producer } = setup();

    await producer.send({
      topic: 't',
      value: {},
      headers: { 'trace-id': 'abc' },
      partition: 3,
      timestamp: 1700000000000n,
    });

    expect(sentMessages(raw)[0]).toMatchObject({
      headers: { 'trace-id': 'abc' },
      partition: 3,
      timestamp: 1700000000000n,
    });
  });

  it('omits optional fields that were not supplied', async () => {
    const { raw, producer } = setup();

    await producer.send({ topic: 't', value: {} });

    expect(Object.keys(sentMessages(raw)[0]).sort()).toEqual(['topic', 'value']);
  });

  it('forwards acks', async () => {
    const { raw, producer } = setup();

    await producer.send({ topic: 't', value: {} }, { acks: 0 });

    expect(raw.send.mock.calls.at(-1)?.[0]).toMatchObject({ acks: 0 });
  });

  it('omits acks when not given, leaving the client default', async () => {
    const { raw, producer } = setup();

    await producer.send({ topic: 't', value: {} });

    expect(raw.send.mock.calls.at(-1)?.[0]).not.toHaveProperty('acks');
  });

  it('spans topics in one batch, resolving a subject per topic', async () => {
    const { registry, producer } = setup();

    await producer.send([
      { topic: 'a', value: 1 },
      { topic: 'b', value: 2 },
    ]);

    expect(registry.getLatestSchemaId.mock.calls.map(c => c[0])).toEqual(['a-value', 'b-value']);
  });

  it('honours a custom subject derivation', async () => {
    const { registry, producer } = setup({}, { subjectFor: topic => `${topic}-payload` });

    await producer.send({ topic: 't', value: {} });

    expect(registry.getLatestSchemaId).toHaveBeenCalledWith('t-payload');
  });
});

describe('encode failures', () => {
  it('wraps a missing subject in SchemaEncodeError', async () => {
    const { producer } = setup({
      getLatestSchemaId: vi.fn(async () => {
        throw new Error('Subject not found');
      }),
    });

    const promise = producer.send({ topic: 'iam.identity.created.v1', value: {} });

    await expect(promise).rejects.toBeInstanceOf(SchemaEncodeError);
    await expect(promise).rejects.toThrow(/No schema available for subject/);
  });

  it('records topic and subject on the error', async () => {
    const { producer } = setup({
      getLatestSchemaId: vi.fn(async () => {
        throw new Error('nope');
      }),
    });

    try {
      await producer.send({ topic: 'orders', value: {} });
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as SchemaEncodeError;
      expect(error.topic).toBe('orders');
      expect(error.subject).toBe('orders-value');
      expect(error.schemaId).toBeUndefined();
      expect(error.cause).toBeInstanceOf(Error);
    }
  });

  it('wraps a payload that does not satisfy the schema, keeping the schema id', async () => {
    const { producer } = setup({
      encode: vi.fn(async () => {
        throw new Error('invalid payload');
      }),
    });

    try {
      await producer.send({ topic: 'orders', value: { wrong: true } });
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as SchemaEncodeError;
      expect(error).toBeInstanceOf(SchemaEncodeError);
      expect(error.schemaId).toBe(42);
    }
  });

  it('does not half-publish a batch when one message fails to encode', async () => {
    let call = 0;
    const { raw, producer } = setup({
      encode: vi.fn(async (_id: number, payload: unknown) => {
        if (++call === 2) throw new Error('invalid payload');
        return Buffer.from(JSON.stringify(payload));
      }),
    });

    await expect(
      producer.send([
        { topic: 't', value: { ok: 1 } },
        { topic: 't', value: { bad: 1 } },
      ]),
    ).rejects.toBeInstanceOf(SchemaEncodeError);

    expect(raw.send).not.toHaveBeenCalled();
  });
});

describe('schema id cache', () => {
  it('resolves a subject once and reuses it', async () => {
    const { registry, producer } = setup();

    await producer.send({ topic: 't', value: 1 });
    await producer.send({ topic: 't', value: 2 });

    expect(registry.getLatestSchemaId).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent lookups for one subject', async () => {
    const { registry, producer } = setup();

    await Promise.all([
      producer.send({ topic: 't', value: 1 }),
      producer.send({ topic: 't', value: 2 }),
      producer.send({ topic: 't', value: 3 }),
    ]);

    expect(registry.getLatestSchemaId).toHaveBeenCalledTimes(1);
  });

  it('expires entries so a registry update is eventually seen — no forever-cache', async () => {
    let now = 0;
    const { registry, producer } = setup({}, { schemaCacheTtlMs: 1_000, now: () => now });

    await producer.send({ topic: 't', value: 1 });
    now = 999;
    await producer.send({ topic: 't', value: 2 });
    now = 1_001;
    await producer.send({ topic: 't', value: 3 });

    expect(registry.getLatestSchemaId).toHaveBeenCalledTimes(2);
  });

  it('disables caching entirely at ttl 0', async () => {
    const { registry, producer } = setup({}, { schemaCacheTtlMs: 0 });

    await producer.send({ topic: 't', value: 1 });
    await producer.send({ topic: 't', value: 2 });

    expect(registry.getLatestSchemaId).toHaveBeenCalledTimes(2);
  });

  it('clearSchemaCache() drops every subject', async () => {
    const { registry, producer } = setup();

    await producer.send({ topic: 'a', value: 1 });
    await producer.send({ topic: 'b', value: 1 });
    producer.clearSchemaCache();
    await producer.send({ topic: 'a', value: 2 });
    await producer.send({ topic: 'b', value: 2 });

    expect(registry.getLatestSchemaId).toHaveBeenCalledTimes(4);
  });

  it('clearSchemaCache(subject) drops only that subject', async () => {
    const { registry, producer } = setup();

    await producer.send({ topic: 'a', value: 1 });
    await producer.send({ topic: 'b', value: 1 });
    producer.clearSchemaCache('a-value');
    await producer.send({ topic: 'a', value: 2 });
    await producer.send({ topic: 'b', value: 2 });

    expect(registry.getLatestSchemaId).toHaveBeenCalledTimes(3);
  });

  it('does not cache a failed lookup', async () => {
    let attempt = 0;
    const { registry, producer } = setup({
      getLatestSchemaId: vi.fn(async () => {
        if (++attempt === 1) throw new Error('registry down');
        return 5;
      }),
    });

    await expect(producer.send({ topic: 't', value: 1 })).rejects.toBeInstanceOf(
      SchemaEncodeError,
    );
    await expect(producer.send({ topic: 't', value: 2 })).resolves.toBeDefined();

    expect(registry.getLatestSchemaId).toHaveBeenCalledTimes(2);
  });
});

describe('lifecycle', () => {
  it('close() closes the underlying producer', async () => {
    const { raw, producer } = setup();

    await producer.close();

    expect(raw.close).toHaveBeenCalledOnce();
  });

  it('onDestroy() closes the underlying producer', async () => {
    const { raw, producer } = setup();

    await producer.onDestroy();

    expect(raw.close).toHaveBeenCalledOnce();
  });

  it('registers no process signal handlers', () => {
    const before = {
      SIGTERM: process.listenerCount('SIGTERM'),
      SIGINT: process.listenerCount('SIGINT'),
    };

    setup();

    expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
    expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
  });
});
