import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createKafkaConfig, KafkaConfigError, SASL_MECHANISMS } from '../index.js';
import { baseConfig, clearKafkaEnv } from './helpers.js';

const savedEnv = { ...process.env };

beforeEach(() => {
  clearKafkaEnv();
});

afterEach(() => {
  process.env = { ...savedEnv };
});

describe('createKafkaConfig', () => {
  describe('from overrides', () => {
    it('resolves a minimal config', () => {
      const config = createKafkaConfig(baseConfig);

      expect(config).toEqual({
        clientId: 'test-service',
        brokers: ['redpanda:9092'],
        schemaRegistry: { url: 'http://redpanda:8081' },
        schemasDir: './schemas',
        allowAutoTopicCreation: false,
      });
    });

    it('defaults schemasDir to ./schemas', () => {
      const config = createKafkaConfig({ ...baseConfig, schemasDir: undefined });
      expect(config.schemasDir).toBe('./schemas');
    });

    it('omits sasl and tls when neither is configured', () => {
      const config = createKafkaConfig(baseConfig);
      expect(config.sasl).toBeUndefined();
      expect(config.tls).toBeUndefined();
    });
  });

  describe('from environment', () => {
    it('reads every endpoint from env', () => {
      process.env.KAFKA_CLIENT_ID = 'svc-iam';
      process.env.KAFKA_BROKERS = 'a:9092,b:9092';
      process.env.KAFKA_SCHEMA_REGISTRY_URL = 'http://sr:8081';
      process.env.KAFKA_SCHEMAS_DIR = './proto';

      const config = createKafkaConfig();

      expect(config.clientId).toBe('svc-iam');
      expect(config.brokers).toEqual(['a:9092', 'b:9092']);
      expect(config.schemaRegistry.url).toBe('http://sr:8081');
      expect(config.schemasDir).toBe('./proto');
    });

    it('trims and drops empty entries in KAFKA_BROKERS', () => {
      process.env.KAFKA_CLIENT_ID = 'svc';
      process.env.KAFKA_BROKERS = ' a:9092 , ,b:9092,';
      process.env.KAFKA_SCHEMA_REGISTRY_URL = 'http://sr:8081';

      expect(createKafkaConfig().brokers).toEqual(['a:9092', 'b:9092']);
    });

    it('treats a whitespace-only env var as unset', () => {
      process.env.KAFKA_CLIENT_ID = '   ';
      expect(() => createKafkaConfig({ ...baseConfig, clientId: undefined })).toThrow(
        KafkaConfigError,
      );
    });

    it('overrides win over env', () => {
      process.env.KAFKA_CLIENT_ID = 'from-env';
      process.env.KAFKA_BROKERS = 'env:9092';
      process.env.KAFKA_SCHEMA_REGISTRY_URL = 'http://env:8081';

      const config = createKafkaConfig(baseConfig);

      expect(config.clientId).toBe('test-service');
      expect(config.brokers).toEqual(['redpanda:9092']);
      expect(config.schemaRegistry.url).toBe('http://redpanda:8081');
    });

    it('reads schema registry basic auth from env', () => {
      process.env.KAFKA_SCHEMA_REGISTRY_USERNAME = 'sr-user';
      process.env.KAFKA_SCHEMA_REGISTRY_PASSWORD = 'sr-pass';

      const config = createKafkaConfig(baseConfig);

      expect(config.schemaRegistry.auth).toEqual({ username: 'sr-user', password: 'sr-pass' });
    });

    it('rejects half-configured registry auth', () => {
      process.env.KAFKA_SCHEMA_REGISTRY_USERNAME = 'sr-user';

      expect(() => createKafkaConfig(baseConfig)).toThrow(
        /must be set together/,
      );
    });
  });

  describe('required fields', () => {
    it('throws when clientId is missing', () => {
      expect(() => createKafkaConfig({ ...baseConfig, clientId: undefined })).toThrow(
        /KAFKA_CLIENT_ID/,
      );
    });

    it('throws when brokers are missing', () => {
      expect(() => createKafkaConfig({ ...baseConfig, brokers: undefined })).toThrow(
        /KAFKA_BROKERS/,
      );
    });

    it('throws when brokers is empty', () => {
      expect(() => createKafkaConfig({ ...baseConfig, brokers: [] })).toThrow(KafkaConfigError);
    });

    it('throws when a broker entry is blank', () => {
      expect(() => createKafkaConfig({ ...baseConfig, brokers: ['a:9092', '  '] })).toThrow(
        KafkaConfigError,
      );
    });

    it('throws when the schema registry url is missing', () => {
      expect(() =>
        createKafkaConfig({ ...baseConfig, schemaRegistry: {} }),
      ).toThrow(/KAFKA_SCHEMA_REGISTRY_URL/);
    });

    it('throws a typed KafkaConfigError, not a bare Error', () => {
      try {
        createKafkaConfig({});
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(KafkaConfigError);
        expect((err as Error).name).toBe('KafkaConfigError');
      }
    });

    it('rejects a non-object override', () => {
      expect(() => createKafkaConfig([] as never)).toThrow(/must be an object/);
    });
  });

  describe('SASL', () => {
    it('builds oauthbearer from env plus a code-supplied tokenProvider', () => {
      process.env.KAFKA_SASL_MECHANISM = 'oauthbearer';
      const tokenProvider = async () => 'tok';

      const config = createKafkaConfig({ ...baseConfig, tokenProvider });

      expect(config.sasl).toEqual({ mechanism: 'oauthbearer', tokenProvider });
    });

    it('refuses oauthbearer without a tokenProvider', () => {
      process.env.KAFKA_SASL_MECHANISM = 'oauthbearer';

      expect(() => createKafkaConfig(baseConfig)).toThrow(/requires a `tokenProvider`/);
    });

    it('names serviceToken in the oauthbearer error so the fix is obvious', () => {
      process.env.KAFKA_SASL_MECHANISM = 'oauthbearer';
      expect(() => createKafkaConfig(baseConfig)).toThrow(/serviceToken/);
    });

    it.each(['scram-sha-256', 'scram-sha-512', 'plain'])(
      'builds %s from env credentials',
      mechanism => {
        process.env.KAFKA_SASL_MECHANISM = mechanism;
        process.env.KAFKA_SASL_USERNAME = 'u';
        process.env.KAFKA_SASL_PASSWORD = 'p';

        expect(createKafkaConfig(baseConfig).sasl).toEqual({
          mechanism,
          username: 'u',
          password: 'p',
        });
      },
    );

    it('refuses SCRAM without credentials', () => {
      process.env.KAFKA_SASL_MECHANISM = 'scram-sha-512';
      process.env.KAFKA_SASL_USERNAME = 'u';

      expect(() => createKafkaConfig(baseConfig)).toThrow(
        /KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD/,
      );
    });

    it('rejects an unsupported mechanism and lists the supported ones', () => {
      process.env.KAFKA_SASL_MECHANISM = 'gssapi';

      expect(() => createKafkaConfig(baseConfig)).toThrow(
        new RegExp(SASL_MECHANISMS.join(', ')),
      );
    });

    it('an explicit sasl override wins over env entirely', () => {
      process.env.KAFKA_SASL_MECHANISM = 'oauthbearer';

      const config = createKafkaConfig({
        ...baseConfig,
        sasl: { mechanism: 'scram-sha-256', username: 'u', password: 'p' },
      });

      expect(config.sasl).toEqual({ mechanism: 'scram-sha-256', username: 'u', password: 'p' });
    });

    it('validates an explicit sasl override', () => {
      expect(() =>
        createKafkaConfig({
          ...baseConfig,
          sasl: { mechanism: 'scram-sha-256', username: '', password: 'p' },
        }),
      ).toThrow(/sasl.username/);
    });

    it('rejects an oauthbearer override whose tokenProvider is not a function', () => {
      expect(() =>
        createKafkaConfig({
          ...baseConfig,
          sasl: { mechanism: 'oauthbearer', tokenProvider: 'a-token' as never },
        }),
      ).toThrow(/sasl.tokenProvider must be a function/);
    });

    it('rejects an unknown mechanism supplied in code', () => {
      expect(() =>
        createKafkaConfig({ ...baseConfig, sasl: { mechanism: 'kerberos' } as never }),
      ).toThrow(/sasl.mechanism must be one of/);
    });
  });

  describe('TLS', () => {
    it('is undefined unless KAFKA_TLS is true', () => {
      process.env.KAFKA_TLS = 'false';
      expect(createKafkaConfig(baseConfig).tls).toBeUndefined();
    });

    it('reads caPath and rejectUnauthorized from env', () => {
      process.env.KAFKA_TLS = 'true';
      process.env.KAFKA_TLS_CA_PATH = '/etc/ca.pem';
      process.env.KAFKA_TLS_REJECT_UNAUTHORIZED = '0';

      expect(createKafkaConfig(baseConfig).tls).toEqual({
        enabled: true,
        caPath: '/etc/ca.pem',
        rejectUnauthorized: false,
      });
    });

    it('accepts 1/0 as booleans', () => {
      process.env.KAFKA_TLS = '1';
      expect(createKafkaConfig(baseConfig).tls).toEqual({ enabled: true });
    });

    it('rejects a non-boolean env value', () => {
      process.env.KAFKA_TLS = 'yes';
      expect(() => createKafkaConfig(baseConfig)).toThrow(/must be "true" or "false"/);
    });

    it('validates an explicit tls override', () => {
      expect(() =>
        createKafkaConfig({ ...baseConfig, tls: { enabled: true, caPath: '' } }),
      ).toThrow(/tls.caPath/);
    });

    it('rejects a non-boolean rejectUnauthorized override', () => {
      expect(() =>
        createKafkaConfig({
          ...baseConfig,
          tls: { enabled: true, rejectUnauthorized: 'no' as never },
        }),
      ).toThrow(/tls.rejectUnauthorized/);
    });
  });

  describe('allowAutoTopicCreation', () => {
    it('is false by default — the cluster disables auto-creation', () => {
      expect(createKafkaConfig(baseConfig).allowAutoTopicCreation).toBe(false);
    });

    it('can be turned on by env for local dev', () => {
      process.env.KAFKA_ALLOW_AUTO_TOPIC_CREATION = 'true';
      expect(createKafkaConfig(baseConfig).allowAutoTopicCreation).toBe(true);
    });

    it('has no config field — code cannot turn it on', () => {
      const config = createKafkaConfig({
        ...baseConfig,
        allowAutoTopicCreation: true,
      } as never);

      expect(config.allowAutoTopicCreation).toBe(false);
    });

    it('rejects a non-boolean env value', () => {
      process.env.KAFKA_ALLOW_AUTO_TOPIC_CREATION = 'maybe';
      expect(() => createKafkaConfig(baseConfig)).toThrow(KafkaConfigError);
    });
  });
});
