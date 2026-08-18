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
