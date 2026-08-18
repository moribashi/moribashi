import {
  asFunction,
  asValue,
  Lifetime,
  type MoribashiApp,
  type MoribashiPlugin,
} from '@moribashi/core';
import {
  createKafkaClient,
  type KafkaClient,
  type SchemaRegistryClient,
} from './client.js';
import type { KafkaConfigInput } from './config.js';
import { KafkaConfigError } from './errors.js';
import { createConsumer, type CreateConsumerOptions, type KafkaConsumer } from './consumer.js';
import { createProducer, type CreateProducerOptions, type KafkaProducer } from './producer.js';
import { registerSchemas, type Logger } from './schemas.js';

/** Services `kafkaPlugin` registers in the root container. */
export interface KafkaCradle {
  kafkaClient: KafkaClient;
  schemaRegistry: SchemaRegistryClient;
  producer: KafkaProducer;
}

export interface KafkaPluginOptions extends KafkaConfigInput {
  /** BYO client. When given, config fields on these options are ignored. */
  client?: KafkaClient;
  /**
   * Register this service's `.proto` schemas during `register()`, before the
   * app finishes starting. `true` uses the configured `schemasDir`; a string
   * overrides the directory.
   *
   * Off by default and deliberately explicit: **only a producer should
   * register**. A consumer that registers a schema is asserting a contract it
   * does not own.
   */
  registerSchemas?: boolean | string;
  /** See `CreateProducerOptions.schemaCacheTtlMs`. */
  schemaCacheTtlMs?: CreateProducerOptions['schemaCacheTtlMs'];
  /** Structured logger for schema registration. Defaults to `console.warn`. */
  log?: Logger;
}

/**
 * Moribashi plugin that registers the Kafka transport on the root container:
 *
 * - `kafkaClient` — resolved config, connection options, schema registry
 * - `schemaRegistry` — the shared Schema Registry client
 * - `producer` — a schema-aware `KafkaProducer`
 *
 * With `registerSchemas`, the service's `.proto` files are registered during
 * `register()` — which `app.start()` awaits before resolving singletons — so
 * an incompatible contract change throws before the app is ever serving.
 *
 * `producer` is registered as a **singleton** so core's lifecycle calls its
 * `onDestroy` on `app.stop()`, the same reason `@moribashi/pg` registers `db`
 * as one. That is also why this package registers no `SIGTERM`/`SIGINT`
 * handlers of its own: disconnection belongs to the app's lifecycle, not to a
 * transport library racing the service's own shutdown.
 */
export function kafkaPlugin(opts: KafkaPluginOptions = {}): MoribashiPlugin {
  const {
    client: providedClient,
    registerSchemas: schemas = false,
    schemaCacheTtlMs,
    log,
    ...configInput
  } = opts;

  // Built here, not inside `register()`: resolving config is pure (it opens no
  // connection), so a bad broker list or a missing registry URL should throw
  // where the plugin is constructed rather than surfacing later as a rejected
  // `app.start()`.
  const client = providedClient ?? createKafkaClient(configInput);

  return {
    name: '@moribashi/kafka',
    async register(app: MoribashiApp) {
      app.container.register({
        kafkaClient: asValue(client),
        schemaRegistry: asValue(client.registry),
        producer: asFunction(() =>
          createProducer({ client, schemaCacheTtlMs }),
        ).setLifetime(Lifetime.SINGLETON),
      });

      if (schemas !== false) {
        await registerSchemas({
          client,
          ...(typeof schemas === 'string' ? { dir: schemas } : {}),
          ...(log ? { log } : {}),
        });
      }
    },
  };
}

/** Services `kafkaConsumerPlugin` registers in the root container. */
export interface KafkaConsumerCradle {
  kafkaClient: KafkaClient;
  schemaRegistry: SchemaRegistryClient;
  consumer: KafkaConsumer;
}

export interface KafkaConsumerPluginOptions
  extends Omit<CreateConsumerOptions, 'app' | 'client'>,
    KafkaConfigInput {
  /**
   * BYO client. When omitted, an already-registered `kafkaClient` (from
   * `kafkaPlugin`) is reused, and only failing that is one built from these
   * options — so a service that both produces and consumes shares one client.
   */
  client?: KafkaClient;
}

/**
 * Moribashi plugin that registers a schema-aware Kafka consumer:
 *
 * - `consumer` — a `KafkaConsumer` (**singleton**, so `app.start()` joins the
 *   group via `onInit` and `app.stop()` drains and disconnects via
 *   `onDestroy`; no signal handlers, same as the producer)
 * - `kafkaClient` / `schemaRegistry` — only if `kafkaPlugin` has not already
 *   registered them
 *
 * Handlers bind by an explicit `handlers` map, by `*.handler.ts` convention, or
 * both — explicit wins on conflict. Binding is resolved during `onInit`, not
 * `register()`, so `app.scan()` may run after `app.use()`.
 *
 * Consumers never register schemas; decoding is a registry *lookup* by schema
 * id off the Confluent framing.
 */
export function kafkaConsumerPlugin(opts: KafkaConsumerPluginOptions): MoribashiPlugin {
  const {
    client: providedClient,
    clientId,
    brokers,
    sasl,
    tokenProvider,
    tls,
    schemaRegistry: schemaRegistryConfig,
    schemasDir,
    ...consumerOptions
  } = opts;

  // Checked here because it needs nothing from the app. Broker/registry config
  // is validated in `register()` instead: a client already registered by
  // `kafkaPlugin` makes these options moot, and we only know that from the app.
  if (typeof opts.groupId !== 'string' || opts.groupId.trim() === '') {
    throw new KafkaConfigError(
      'kafkaConsumerPlugin requires a non-empty `groupId` — there is deliberately no default.',
    );
  }

  const configInput: KafkaConfigInput = {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(brokers !== undefined ? { brokers } : {}),
    ...(sasl !== undefined ? { sasl } : {}),
    ...(tokenProvider !== undefined ? { tokenProvider } : {}),
    ...(tls !== undefined ? { tls } : {}),
    ...(schemaRegistryConfig !== undefined ? { schemaRegistry: schemaRegistryConfig } : {}),
    ...(schemasDir !== undefined ? { schemasDir } : {}),
  };

  return {
    name: '@moribashi/kafka/consumer',
    register(app: MoribashiApp) {
      // Reuse the producer plugin's client when there is one — same brokers,
      // same registry, one place for config to be wrong.
      const existing = app.container.hasRegistration('kafkaClient')
        ? app.resolve<KafkaClient>('kafkaClient')
        : undefined;
      const client = providedClient ?? existing ?? createKafkaClient(configInput);

      if (!existing) {
        app.container.register({
          kafkaClient: asValue(client),
          schemaRegistry: asValue(client.registry),
        });
      }

      app.container.register({
        consumer: asFunction(() =>
          createConsumer({ ...consumerOptions, app, client }),
        ).setLifetime(Lifetime.SINGLETON),
      });
    },
  };
}
