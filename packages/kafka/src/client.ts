import { readFileSync } from 'node:fs';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import type { SASLOptions } from '@platformatic/kafka';
import {
  createKafkaConfig,
  type KafkaConfig,
  type KafkaConfigInput,
  type SaslConfig,
  type TlsConfig,
} from './config.js';
import { KafkaConfigError } from './errors.js';
import { createSchemaRegistry, type SchemaRegistryClient } from './registry.js';

export { createSchemaRegistry, type SchemaRegistryClient };

/**
 * Options every `@platformatic/kafka` client built from this client is
 * constructed with. Kept as a plain object rather than a wrapper class —
 * `@platformatic/kafka` has no central "Kafka" object, each client takes its
 * own connection options.
 */
export interface KafkaConnectionOptions {
  clientId: string;
  bootstrapBrokers: string[];
  autocreateTopics: boolean;
  sasl?: SASLOptions;
  tls?: TlsConnectionOptions;
}

/**
 * The framework-free core, analogous to `createKnex()` in `@moribashi/pg`:
 * resolved config, the connection options for `@platformatic/kafka` clients,
 * and one shared Schema Registry client. Usable with no moribashi app.
 */
export interface KafkaClient {
  readonly config: KafkaConfig;
  readonly connectionOptions: KafkaConnectionOptions;
  readonly registry: SchemaRegistryClient;
}

const SASL_MECHANISM_NAMES = {
  'oauthbearer': 'OAUTHBEARER',
  'scram-sha-256': 'SCRAM-SHA-256',
  'scram-sha-512': 'SCRAM-SHA-512',
  'plain': 'PLAIN',
} as const satisfies Record<SaslConfig['mechanism'], SASLOptions['mechanism']>;

function buildSaslOptions(sasl: SaslConfig): SASLOptions {
  if (sasl.mechanism === 'oauthbearer') {
    // `@platformatic/kafka` accepts a credential provider and calls it per
    // (re)authentication, which is exactly the contract a refresh-ahead token
    // provider wants — no token is ever captured at construction time.
    return { mechanism: SASL_MECHANISM_NAMES.oauthbearer, token: sasl.tokenProvider };
  }
  return {
    mechanism: SASL_MECHANISM_NAMES[sasl.mechanism],
    username: sasl.username,
    password: sasl.password,
  };
}

function buildTlsOptions(tls: TlsConfig): TlsConnectionOptions | undefined {
  if (!tls.enabled) return undefined;

  const options: TlsConnectionOptions = {};
  if (tls.caPath) {
    try {
      options.ca = readFileSync(tls.caPath, 'utf8');
    } catch (cause) {
      throw new KafkaConfigError(
        `Failed to read tls.caPath at "${tls.caPath}": ${(cause as Error).message}`,
        { cause },
      );
    }
  }
  if (tls.rejectUnauthorized !== undefined) {
    options.rejectUnauthorized = tls.rejectUnauthorized;
  }
  return options;
}

/** Maps validated config onto the shape `@platformatic/kafka` clients take. */
export function buildConnectionOptions(config: KafkaConfig): KafkaConnectionOptions {
  const tls = config.tls ? buildTlsOptions(config.tls) : undefined;

  return {
    clientId: config.clientId,
    bootstrapBrokers: config.brokers,
    autocreateTopics: config.allowAutoTopicCreation,
    ...(config.sasl ? { sasl: buildSaslOptions(config.sasl) } : {}),
    ...(tls ? { tls } : {}),
  };
}

/** Structural detection of an already-built client (the BYO escape hatch). */
export function isKafkaClient(value: unknown): value is KafkaClient {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<KafkaClient>;
  return (
    typeof candidate.config === 'object' &&
    candidate.config !== null &&
    typeof candidate.connectionOptions === 'object' &&
    candidate.connectionOptions !== null &&
    typeof candidate.registry === 'object' &&
    candidate.registry !== null
  );
}

/**
 * Builds a Kafka client from env vars and/or explicit overrides.
 *
 * Config is validated eagerly, so a bad broker list or a missing registry URL
 * fails here rather than on the first send. Pass an existing `KafkaClient` to
 * use it as-is (BYO escape hatch, detected structurally).
 */
export function createKafkaClient(
  input?: KafkaConfigInput | KafkaClient,
): KafkaClient {
  if (input !== undefined && isKafkaClient(input)) return input;

  const config = createKafkaConfig(input);

  return {
    config,
    connectionOptions: buildConnectionOptions(config),
    registry: createSchemaRegistry(config),
  };
}
