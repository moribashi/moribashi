import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildConnectionOptions,
  createKafkaClient,
  createKafkaConfig,
  createSchemaRegistry,
  isKafkaClient,
  KafkaConfigError,
} from '../index.js';
import { baseConfig, clearKafkaEnv, fakeClient, fakeRegistry } from './helpers.js';

const savedEnv = { ...process.env };

beforeEach(() => {
  clearKafkaEnv();
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('buildConnectionOptions', () => {
  it('maps the plain config onto @platformatic/kafka options', () => {
    const options = buildConnectionOptions(createKafkaConfig(baseConfig));

    expect(options).toEqual({
      clientId: 'test-service',
      bootstrapBrokers: ['redpanda:9092'],
      autocreateTopics: false,
    });
  });

  it('carries the env-only auto-create override through', () => {
    process.env.KAFKA_ALLOW_AUTO_TOPIC_CREATION = 'true';

    expect(buildConnectionOptions(createKafkaConfig(baseConfig)).autocreateTopics).toBe(true);
  });

  it('passes the token provider itself, not a token', async () => {
    let calls = 0;
    const tokenProvider = async () => `token-${++calls}`;

    const options = buildConnectionOptions(
      createKafkaConfig({ ...baseConfig, sasl: { mechanism: 'oauthbearer', tokenProvider } }),
    );

    expect(options.sasl?.mechanism).toBe('OAUTHBEARER');
    // The provider must be invoked per authentication, so a refresh-ahead
    // provider keeps working across reconnects.
    expect(calls).toBe(0);
    await expect((options.sasl?.token as () => Promise<string>)()).resolves.toBe('token-1');
    await expect((options.sasl?.token as () => Promise<string>)()).resolves.toBe('token-2');
  });

  it.each([
    ['scram-sha-256', 'SCRAM-SHA-256'],
    ['scram-sha-512', 'SCRAM-SHA-512'],
    ['plain', 'PLAIN'],
  ])('uppercases the %s mechanism to %s', (mechanism, expected) => {
    const options = buildConnectionOptions(
      createKafkaConfig({
        ...baseConfig,
        sasl: { mechanism: mechanism as 'plain', username: 'u', password: 'p' },
      }),
    );

    expect(options.sasl).toEqual({ mechanism: expected, username: 'u', password: 'p' });
  });

  it('omits tls when disabled', () => {
    const options = buildConnectionOptions(
      createKafkaConfig({ ...baseConfig, tls: { enabled: false } }),
    );

    expect(options.tls).toBeUndefined();
  });

  it('enables tls with no options when no CA or flag is given', () => {
    const options = buildConnectionOptions(
      createKafkaConfig({ ...baseConfig, tls: { enabled: true } }),
    );

    expect(options.tls).toEqual({});
  });

  it('passes rejectUnauthorized through', () => {
    const options = buildConnectionOptions(
      createKafkaConfig({ ...baseConfig, tls: { enabled: true, rejectUnauthorized: false } }),
    );

    expect(options.tls).toEqual({ rejectUnauthorized: false });
  });

  describe('CA bundle', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kafka-tls-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('reads the CA file at construction time', async () => {
      const caPath = path.join(tmpDir, 'ca.pem');
      await fs.writeFile(caPath, '-----BEGIN CERTIFICATE-----\nabc\n');

      const options = buildConnectionOptions(
        createKafkaConfig({ ...baseConfig, tls: { enabled: true, caPath } }),
      );

      expect(options.tls?.ca).toContain('BEGIN CERTIFICATE');
    });

    it('throws a typed config error when the CA file is unreadable', () => {
      const caPath = path.join(tmpDir, 'missing.pem');

      expect(() =>
        buildConnectionOptions(
          createKafkaConfig({ ...baseConfig, tls: { enabled: true, caPath } }),
        ),
      ).toThrow(KafkaConfigError);
    });

    it('names the unreadable path in the error', () => {
      const caPath = path.join(tmpDir, 'missing.pem');

      expect(() =>
        buildConnectionOptions(
          createKafkaConfig({ ...baseConfig, tls: { enabled: true, caPath } }),
        ),
      ).toThrow(new RegExp(caPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });
});

describe('isKafkaClient', () => {
  it('recognises a built client', () => {
    expect(isKafkaClient(fakeClient())).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'client'],
    ['config input', baseConfig],
    ['a partial client', { config: {}, registry: {} }],
  ])('rejects %s', (_label, value) => {
    expect(isKafkaClient(value)).toBe(false);
  });
});

describe('createKafkaClient', () => {
  it('builds config, connection options and a registry', () => {
    const client = createKafkaClient(baseConfig);

    expect(client.config.clientId).toBe('test-service');
    expect(client.connectionOptions.bootstrapBrokers).toEqual(['redpanda:9092']);
    expect(typeof client.registry.getLatestSchemaId).toBe('function');
  });

  it('returns an existing client untouched (BYO escape hatch)', () => {
    const existing = fakeClient();
    expect(createKafkaClient(existing)).toBe(existing);
  });

  it('does not re-validate a BYO client', () => {
    const existing = fakeClient();
    // A BYO client short-circuits before config resolution, so even a hostile
    // environment cannot break it.
    process.env.KAFKA_SASL_MECHANISM = 'nonsense';
    expect(() => createKafkaClient(existing)).not.toThrow();
  });

  it('validates eagerly when given config', () => {
    expect(() => createKafkaClient({ clientId: 'x' })).toThrow(KafkaConfigError);
  });

  it('falls back to env when called with no arguments', () => {
    process.env.KAFKA_CLIENT_ID = 'env-service';
    process.env.KAFKA_BROKERS = 'env:9092';
    process.env.KAFKA_SCHEMA_REGISTRY_URL = 'http://env:8081';

    expect(createKafkaClient().config.clientId).toBe('env-service');
  });
});

describe('createSchemaRegistry', () => {
  it('produces something matching the SchemaRegistryClient contract', () => {
    const registry = createSchemaRegistry(createKafkaConfig(baseConfig));

    for (const method of ['register', 'encode', 'decode', 'getLatestSchemaId'] as const) {
      expect(typeof registry[method]).toBe('function');
    }
  });

  it('accepts basic auth without throwing', () => {
    expect(() =>
      createSchemaRegistry(
        createKafkaConfig({
          ...baseConfig,
          schemaRegistry: { url: 'http://sr:8081', auth: { username: 'u', password: 'p' } },
        }),
      ),
    ).not.toThrow();
  });
});

describe('fakeClient fixture', () => {
  it('satisfies isKafkaClient with an injected registry', () => {
    const registry = fakeRegistry();
    const client = fakeClient(baseConfig, registry);

    expect(isKafkaClient(client)).toBe(true);
    expect(client.registry).toBe(registry);
  });
});
