import { vi, type Mock } from 'vitest';
import type { KafkaClient, KafkaConfigInput, SchemaRegistryClient } from '../index.js';
import { buildConnectionOptions, createKafkaConfig } from '../index.js';
import type { RawProducer } from '../producer.js';

/** Every env var `createKafkaConfig` reads — cleared between tests. */
export const KAFKA_ENV_VARS = [
  'KAFKA_CLIENT_ID',
  'KAFKA_BROKERS',
  'KAFKA_SASL_MECHANISM',
  'KAFKA_SASL_USERNAME',
  'KAFKA_SASL_PASSWORD',
  'KAFKA_TLS',
  'KAFKA_TLS_CA_PATH',
  'KAFKA_TLS_REJECT_UNAUTHORIZED',
  'KAFKA_SCHEMA_REGISTRY_URL',
  'KAFKA_SCHEMA_REGISTRY_USERNAME',
  'KAFKA_SCHEMA_REGISTRY_PASSWORD',
  'KAFKA_SCHEMAS_DIR',
  'KAFKA_ALLOW_AUTO_TOPIC_CREATION',
] as const;

export function clearKafkaEnv(): void {
  for (const name of KAFKA_ENV_VARS) delete process.env[name];
}

/** The minimum config that passes validation. */
export const baseConfig: KafkaConfigInput = {
  clientId: 'test-service',
  brokers: ['redpanda:9092'],
  schemaRegistry: { url: 'http://redpanda:8081' },
  schemasDir: './schemas',
};

/** Every method of the registry seam, stubbed. */
export type RegistryStubs = { [K in keyof SchemaRegistryClient]: Mock };
export type FakeRegistry = SchemaRegistryClient & RegistryStubs;

/**
 * A stand-in for the registry seam. `encode` produces a deterministic,
 * inspectable buffer so tests can assert *which* value was framed for *which*
 * topic without decoding Confluent wire format — the real framing is asserted
 * byte for byte in `wire-format.test.ts`, which is where it belongs.
 */
export function fakeRegistry(overrides: Partial<RegistryStubs> = {}): FakeRegistry {
  return {
    register: vi.fn(async () => 1),
    getLatestSchemaId: vi.fn(async () => 42),
    encode: vi.fn(async (topic: string, value: unknown) =>
      Buffer.from(`${topic}:${JSON.stringify(value)}`),
    ),
    decode: vi.fn(async () => ({})),
    clearCaches: vi.fn(() => {}),
    ...overrides,
  } as unknown as FakeRegistry;
}

/** A `KafkaClient` with a fake registry — no network, no real registry client. */
export function fakeClient(
  input: KafkaConfigInput = baseConfig,
  registry: SchemaRegistryClient = fakeRegistry(),
): KafkaClient {
  const config = createKafkaConfig(input);
  return { config, connectionOptions: buildConnectionOptions(config), registry };
}

export interface FakeRawProducer {
  send: Mock;
  close: Mock;
}

/** A stand-in for the `@platformatic/kafka` producer. */
export function fakeRawProducer(
  overrides: Partial<FakeRawProducer> = {},
): FakeRawProducer & RawProducer {
  const fake: FakeRawProducer = {
    send: vi.fn(async () => ({ offsets: [] })),
    close: vi.fn(async () => {}),
    ...overrides,
  };
  return fake as unknown as FakeRawProducer & RawProducer;
}

/** A `fetch` stand-in returning one canned JSON response per call. */
export function fakeFetch(
  responses: Array<{ status?: number; body?: unknown; text?: string }>,
): typeof fetch & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;

  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const spec = responses[Math.min(index++, responses.length - 1)] ?? {};
    const status = spec.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => spec.body,
      text: async () => spec.text ?? JSON.stringify(spec.body ?? ''),
    };
  }) as unknown as typeof fetch & { calls: typeof calls };

  impl.calls = calls;
  return impl;
}

// ---------------------------------------------------------------------------
// Consumer fakes
// ---------------------------------------------------------------------------

export interface FakeConsumedMessage {
  topic: string;
  partition: number;
  offset: bigint;
  key?: Buffer;
  value: Buffer;
  headers: Map<string, string>;
  timestamp: bigint;
  commit: Mock;
}

let nextOffset = 0n;

/** One message as `@platformatic/kafka` would hand it to us. */
export function fakeMessage(
  overrides: Partial<Omit<FakeConsumedMessage, 'commit' | 'headers'>> & {
    headers?: Record<string, string>;
  } = {},
): FakeConsumedMessage {
  const { headers, ...rest } = overrides;
  return {
    topic: 't',
    partition: 0,
    offset: nextOffset++,
    key: Buffer.from('k'),
    value: Buffer.from('encoded'),
    timestamp: 1_700_000_000_000n,
    ...rest,
    headers: new Map(Object.entries(headers ?? {})),
    commit: vi.fn(async () => {}),
  };
}

export interface FakeStream {
  close: Mock;
  closed: boolean;
  [Symbol.asyncIterator](): AsyncIterator<FakeConsumedMessage>;
}

/**
 * A stream that yields the given messages and then ends — which lets a test
 * `await consumer.finished` instead of polling. A real stream never ends;
 * `close()` is what stops it, and that is exercised too.
 */
export function fakeStream(messages: FakeConsumedMessage[]): FakeStream {
  const stream: FakeStream = {
    closed: false,
    close: vi.fn(async () => {
      stream.closed = true;
    }),
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        if (stream.closed) return;
        yield message;
      }
    },
  };
  return stream;
}

export interface FakeRawConsumer {
  consume: Mock;
  close: Mock;
  lastConsumeOptions?: Record<string, unknown>;
}

export function fakeRawConsumer(stream: FakeStream): FakeRawConsumer {
  const fake: FakeRawConsumer = {
    consume: vi.fn(async (options: Record<string, unknown>) => {
      fake.lastConsumeOptions = options;
      return stream;
    }),
    close: vi.fn(async () => {}),
  };
  return fake;
}
