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
 * A stand-in for `SchemaRegistry`. `encode` produces a deterministic,
 * inspectable buffer so tests can assert *which* payload was framed with
 * *which* schema id without decoding Confluent wire format.
 */
export function fakeRegistry(overrides: Partial<RegistryStubs> = {}): FakeRegistry {
  return {
    register: vi.fn(async () => ({ id: 1 })),
    encode: vi.fn(async (id: number, payload: unknown) =>
      Buffer.from(`${id}:${JSON.stringify(payload)}`),
    ),
    decode: vi.fn(async () => ({})),
    getLatestSchemaId: vi.fn(async () => 42),
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
