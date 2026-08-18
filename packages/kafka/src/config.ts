import { KafkaConfigError } from './errors.js';

/**
 * Supplies a bearer token for SASL/OAUTHBEARER. Deliberately a bare function
 * type rather than an import from `@moribashi/auth`: this package must not
 * take a dependency on auth (the build order is
 * `common → core → {cli, graphql, kafka, pg, web} → auth`, and a kafka→auth
 * edge would invert it).
 *
 * A service that already registers `workloadIdentityPlugin` wires the two
 * together at the call site:
 *
 * ```ts
 * kafkaPlugin({ tokenProvider: () => app.resolve<ServiceToken>('serviceToken').get() })
 * ```
 */
export type TokenProvider = () => string | Promise<string>;

export const SASL_MECHANISMS = [
  'oauthbearer',
  'scram-sha-256',
  'scram-sha-512',
  'plain',
] as const;

export type SaslMechanism = (typeof SASL_MECHANISMS)[number];

/** SASL/OAUTHBEARER — the token comes from code, never from env. */
export interface OauthBearerSaslConfig {
  mechanism: 'oauthbearer';
  tokenProvider: TokenProvider;
}

/** SASL mechanisms that authenticate with a username and password. */
export interface PasswordSaslConfig {
  mechanism: 'scram-sha-256' | 'scram-sha-512' | 'plain';
  username: string;
  password: string;
}

export type SaslConfig = OauthBearerSaslConfig | PasswordSaslConfig;

/**
 * TLS for the broker connection. Required for `SASL_SSL` listeners. When
 * `enabled` is false the rest of this object is ignored.
 */
export interface TlsConfig {
  enabled: boolean;
  /** Path to a PEM CA bundle, read at client-construction time. */
  caPath?: string;
  /** Defaults to `true`. `false` is insecure — short-lived debugging only. */
  rejectUnauthorized?: boolean;
}

export interface SchemaRegistryConfig {
  url: string;
  auth?: { username: string; password: string };
}

/** Fully-resolved, validated configuration. */
export interface KafkaConfig {
  clientId: string;
  brokers: string[];
  sasl?: SaslConfig;
  tls?: TlsConfig;
  schemaRegistry: SchemaRegistryConfig;
  /** Directory of `.proto` files this service *owns* and registers at boot. */
  schemasDir: string;
  /**
   * Never settable from code — see `KAFKA_ALLOW_AUTO_TOPIC_CREATION`. The
   * cluster runs with `auto_create_topics_enabled: false`, so this is `false`
   * in every real deployment.
   */
  allowAutoTopicCreation: boolean;
}

/**
 * Config as callers supply it. Every field is optional: the base comes from
 * the environment, and anything given here wins.
 *
 * Note there is no `allowAutoTopicCreation` — that knob is env-only on
 * purpose (see `KAFKA_ALLOW_AUTO_TOPIC_CREATION`).
 */
export interface KafkaConfigInput {
  clientId?: string;
  brokers?: string[];
  /** Fully-specified SASL config. Wins over anything derived from env. */
  sasl?: SaslConfig;
  /**
   * Token source for SASL/OAUTHBEARER. Required when the mechanism is
   * `oauthbearer` and `sasl` is not given in full.
   */
  tokenProvider?: TokenProvider;
  tls?: TlsConfig;
  schemaRegistry?: Partial<SchemaRegistryConfig>;
  schemasDir?: string;
}

const DEFAULT_SCHEMAS_DIR = './schemas';

function trimmed(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function parseBooleanEnv(name: string): boolean | undefined {
  const value = trimmed(name);
  if (value === undefined) return undefined;
  const lowered = value.toLowerCase();
  if (lowered === 'true' || lowered === '1') return true;
  if (lowered === 'false' || lowered === '0') return false;
  throw new KafkaConfigError(
    `${name} must be "true" or "false" (got "${value}").`,
  );
}

/**
 * `allowAutoTopicCreation` has no config field by design: the cluster
 * disables auto-creation, and a topic that appears because a typo'd name got
 * produced to is a silent data-loss bug. The env var exists so a local
 * single-node Redpanda can be convenient — **local dev only**.
 */
function resolveAllowAutoTopicCreation(): boolean {
  return parseBooleanEnv('KAFKA_ALLOW_AUTO_TOPIC_CREATION') ?? false;
}

function resolveSaslFromEnv(tokenProvider?: TokenProvider): SaslConfig | undefined {
  const mechanism = trimmed('KAFKA_SASL_MECHANISM');
  if (mechanism === undefined) return undefined;

  if (!(SASL_MECHANISMS as readonly string[]).includes(mechanism)) {
    throw new KafkaConfigError(
      `KAFKA_SASL_MECHANISM must be one of ${SASL_MECHANISMS.join(', ')} (got "${mechanism}").`,
    );
  }

  if (mechanism === 'oauthbearer') {
    if (tokenProvider === undefined) {
      throw new KafkaConfigError(
        'SASL/OAUTHBEARER requires a `tokenProvider` — a token cannot come from the ' +
          'environment. Wire it to @moribashi/auth\'s `serviceToken`, e.g. ' +
          '`tokenProvider: () => app.resolve<ServiceToken>("serviceToken").get()`.',
      );
    }
    return { mechanism, tokenProvider };
  }

  const username = trimmed('KAFKA_SASL_USERNAME');
  const password = trimmed('KAFKA_SASL_PASSWORD');
  if (!username || !password) {
    throw new KafkaConfigError(
      `KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD are both required for SASL "${mechanism}".`,
    );
  }

  return { mechanism: mechanism as PasswordSaslConfig['mechanism'], username, password };
}

function resolveTlsFromEnv(): TlsConfig | undefined {
  const enabled = parseBooleanEnv('KAFKA_TLS');
  if (enabled !== true) return undefined;

  const caPath = trimmed('KAFKA_TLS_CA_PATH');
  const rejectUnauthorized = parseBooleanEnv('KAFKA_TLS_REJECT_UNAUTHORIZED');

  return {
    enabled: true,
    ...(caPath !== undefined ? { caPath } : {}),
    ...(rejectUnauthorized !== undefined ? { rejectUnauthorized } : {}),
  };
}

function resolveRegistryAuthFromEnv(): SchemaRegistryConfig['auth'] {
  const username = trimmed('KAFKA_SCHEMA_REGISTRY_USERNAME');
  const password = trimmed('KAFKA_SCHEMA_REGISTRY_PASSWORD');
  if (username === undefined && password === undefined) return undefined;
  if (username === undefined || password === undefined) {
    throw new KafkaConfigError(
      'KAFKA_SCHEMA_REGISTRY_USERNAME and KAFKA_SCHEMA_REGISTRY_PASSWORD must be set together.',
    );
  }
  return { username, password };
}

function assertNonEmptyString(
  value: unknown,
  field: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KafkaConfigError(`${field} must be a non-empty string.`);
  }
}

function validate(config: KafkaConfig): KafkaConfig {
  // No defaults for the three network endpoints — a service that silently
  // falls back to localhost in production is a worse failure than a crashloop.
  assertNonEmptyString(config.clientId, 'clientId (set KAFKA_CLIENT_ID)');

  if (
    !Array.isArray(config.brokers) ||
    config.brokers.length === 0 ||
    config.brokers.some(b => typeof b !== 'string' || b.trim() === '')
  ) {
    throw new KafkaConfigError(
      'brokers (set KAFKA_BROKERS) must contain at least one non-empty broker ' +
        'address, e.g. "redpanda:9092".',
    );
  }

  assertNonEmptyString(
    config.schemaRegistry?.url,
    'schemaRegistry.url (set KAFKA_SCHEMA_REGISTRY_URL)',
  );
  assertNonEmptyString(config.schemasDir, 'schemasDir');

  if (config.schemaRegistry.auth !== undefined) {
    assertNonEmptyString(config.schemaRegistry.auth.username, 'schemaRegistry.auth.username');
    assertNonEmptyString(config.schemaRegistry.auth.password, 'schemaRegistry.auth.password');
  }

  if (config.sasl !== undefined) {
    switch (config.sasl.mechanism) {
      case 'oauthbearer':
        if (typeof config.sasl.tokenProvider !== 'function') {
          throw new KafkaConfigError('sasl.tokenProvider must be a function.');
        }
        break;
      case 'plain':
      case 'scram-sha-256':
      case 'scram-sha-512':
        assertNonEmptyString(config.sasl.username, 'sasl.username');
        assertNonEmptyString(config.sasl.password, 'sasl.password');
        break;
      default:
        throw new KafkaConfigError(
          `sasl.mechanism must be one of ${SASL_MECHANISMS.join(', ')} ` +
            `(got "${(config.sasl as { mechanism: string }).mechanism}").`,
        );
    }
  }

  if (config.tls !== undefined) {
    if (typeof config.tls.enabled !== 'boolean') {
      throw new KafkaConfigError('tls.enabled must be a boolean.');
    }
    if (config.tls.caPath !== undefined) {
      assertNonEmptyString(config.tls.caPath, 'tls.caPath');
    }
    if (
      config.tls.rejectUnauthorized !== undefined &&
      typeof config.tls.rejectUnauthorized !== 'boolean'
    ) {
      throw new KafkaConfigError('tls.rejectUnauthorized must be a boolean when provided.');
    }
  }

  return config;
}

/**
 * Resolves configuration from the environment, applies `overrides` on top,
 * and validates the result **eagerly** — a bad config throws a typed
 * `KafkaConfigError` at construction rather than on the first send.
 *
 * Environment variables:
 *
 * | Variable | Maps to |
 * | --- | --- |
 * | `KAFKA_CLIENT_ID` | `clientId` (required) |
 * | `KAFKA_BROKERS` | `brokers` — comma-separated (required) |
 * | `KAFKA_SASL_MECHANISM` | `sasl.mechanism` |
 * | `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` | SCRAM/PLAIN credentials |
 * | `KAFKA_TLS` / `KAFKA_TLS_CA_PATH` / `KAFKA_TLS_REJECT_UNAUTHORIZED` | `tls` |
 * | `KAFKA_SCHEMA_REGISTRY_URL` | `schemaRegistry.url` (required) |
 * | `KAFKA_SCHEMA_REGISTRY_USERNAME` / `..._PASSWORD` | `schemaRegistry.auth` |
 * | `KAFKA_SCHEMAS_DIR` | `schemasDir` (default `./schemas`) |
 * | `KAFKA_ALLOW_AUTO_TOPIC_CREATION` | `allowAutoTopicCreation` — **local dev only** |
 */
export function createKafkaConfig(overrides: KafkaConfigInput = {}): KafkaConfig {
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new KafkaConfigError('Kafka config overrides must be an object when provided.');
  }

  const brokersFromEnv = trimmed('KAFKA_BROKERS')
    ?.split(',')
    .map(b => b.trim())
    .filter(Boolean);

  // `sasl` given in full wins outright; otherwise the mechanism comes from
  // env and only the token provider comes from code.
  const sasl = overrides.sasl ?? resolveSaslFromEnv(overrides.tokenProvider);

  const tls = overrides.tls ?? resolveTlsFromEnv();
  const registryAuth = overrides.schemaRegistry?.auth ?? resolveRegistryAuthFromEnv();

  const config: KafkaConfig = {
    clientId: overrides.clientId ?? trimmed('KAFKA_CLIENT_ID') ?? '',
    brokers: overrides.brokers ?? brokersFromEnv ?? [],
    ...(sasl ? { sasl } : {}),
    ...(tls ? { tls } : {}),
    schemaRegistry: {
      url:
        overrides.schemaRegistry?.url ?? trimmed('KAFKA_SCHEMA_REGISTRY_URL') ?? '',
      ...(registryAuth ? { auth: registryAuth } : {}),
    },
    schemasDir:
      overrides.schemasDir ?? trimmed('KAFKA_SCHEMAS_DIR') ?? DEFAULT_SCHEMAS_DIR,
    allowAutoTopicCreation: resolveAllowAutoTopicCreation(),
  };

  return validate(config);
}
