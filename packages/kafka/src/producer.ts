import { Producer, type ProduceResult } from '@platformatic/kafka';
import { createKafkaClient, type KafkaClient } from './client.js';
import type { KafkaConfigInput } from './config.js';
import { SchemaEncodeError } from './errors.js';
import type { SchemaRegistryClient } from './registry.js';
import { subjectForTopic } from './subjects.js';

/**
 * The `@platformatic/kafka` producer this package builds. Values and keys are
 * already `Buffer`s by the time they reach it — the value carries Confluent
 * wire framing this package applied, and a key is opaque partitioning bytes —
 * while headers stay strings, which is what every header consumer expects.
 */
export type RawProducer = Producer<Buffer, Buffer, string, string>;

const passthrough = (data?: Buffer): Buffer | undefined => data;
const toBuffer = (data?: string): Buffer | undefined =>
  data === undefined ? undefined : Buffer.from(data);

/**
 * One message to produce.
 *
 * The key is **per message**, not per batch. A single `send()` regularly
 * spans several entities, and one key applied to the whole batch silently
 * mis-partitions every message but the first entity's — the kind of bug that
 * only shows up as out-of-order events under load.
 */
export interface ProducerMessage<T = unknown> {
  topic: string;
  /**
   * Encoded against the topic's registered value schema.
   *
   * Normally a Buf-generated message (`create(IdentityCreatedSchema, {…})`),
   * which is what makes a payload that diverges from the `.proto` a compile
   * error. A plain object is also accepted and is initialised into the type
   * declared for this topic in `messages` — using the **generated** field
   * names (`displayName`, not `display_name`).
   */
  value: T;
  /** Partition key. Strings are UTF-8 encoded. Omit for round-robin. */
  key?: string | Buffer;
  headers?: Record<string, string>;
  /** Explicit partition — overrides key-based partitioning. */
  partition?: number;
  timestamp?: bigint;
}

export interface SendOptions {
  /** `-1` (all ISRs, the default), `0` (fire and forget), or `1` (leader). */
  acks?: number;
}

export interface KafkaProducer {
  /**
   * Encodes each message against its topic's registered value schema and
   * produces the batch.
   */
  send<T = unknown>(
    messages: ProducerMessage<T> | ProducerMessage<T>[],
    options?: SendOptions,
  ): Promise<ProduceResult>;
  /**
   * Drops cached schema lookups so the next send re-resolves them.
   *
   * The cache now lives inside `@confluentinc/schemaregistry`, which keys it
   * by more than the subject, so this clears **all** of it. `subject` is still
   * accepted and still names what the caller cares about, but it no longer
   * narrows what is dropped.
   */
  clearSchemaCache(subject?: string): void;
  /** Escape hatch: the underlying `@platformatic/kafka` producer. */
  readonly producer: RawProducer;
  close(): Promise<void>;
  /** Lifecycle hook — `app.stop()` calls this (duck-typed by core). */
  onDestroy(): Promise<void>;
}

export interface CreateProducerOptions {
  /** BYO client, or config overrides used to build one. */
  client?: KafkaClient | KafkaConfigInput;
  /** BYO registry client. Defaults to the client's. */
  registry?: SchemaRegistryClient;
  /** BYO `@platformatic/kafka` producer. Defaults to one built from config. */
  producer?: RawProducer;
}

/**
 * Builds a schema-aware producer.
 *
 * Framework-free: `kafkaPlugin` uses this, but so can a script or a test.
 * Notably it registers **no process signal handlers** — disconnection is the
 * caller's (or the plugin lifecycle's) business, and a library that calls
 * `process.exit()` fights both `app.stop()` and the service's own shutdown.
 */
export function createProducer(opts: CreateProducerOptions = {}): KafkaProducer {
  const client = createKafkaClient(opts.client);
  const registry = opts.registry ?? client.registry;
  const subjectFor = client.config.subjectFor ?? subjectForTopic;

  const producer: RawProducer =
    opts.producer ??
    new Producer<Buffer, Buffer, string, string>({
      ...client.connectionOptions,
      serializers: {
        key: passthrough,
        value: passthrough,
        headerKey: toBuffer,
        headerValue: toBuffer,
      },
    });

  /**
   * Confluent framing is applied by `@confluentinc/schemaregistry`, never
   * hand-rolled here: `magic | schemaId | message-index array | payload`, with
   * the index array being precisely the part the previous library omitted.
   * Schema-id resolution and its TTL cache live in that client too
   * (`schemaCacheTtlMs`), which is why this function no longer keeps one.
   */
  async function encode<T>(message: ProducerMessage<T>): Promise<Buffer> {
    try {
      return await registry.encode(message.topic, message.value);
    } catch (cause) {
      if (cause instanceof SchemaEncodeError) throw cause;
      throw new SchemaEncodeError(
        `Failed to encode message for topic "${message.topic}": ${(cause as Error).message}`,
        message.topic,
        subjectFor(message.topic),
        undefined,
        { cause },
      );
    }
  }

  const kafkaProducer: KafkaProducer = {
    get producer() {
      return producer;
    },

    async send<T = unknown>(
      messages: ProducerMessage<T> | ProducerMessage<T>[],
      options: SendOptions = {},
    ): Promise<ProduceResult> {
      const batch = Array.isArray(messages) ? messages : [messages];
      if (batch.length === 0) {
        return { offsets: [] };
      }

      // Encode first, produce second: a batch that cannot be encoded must not
      // half-publish.
      const encoded = await Promise.all(
        batch.map(async message => ({
          topic: message.topic,
          value: await encode(message),
          ...(message.key !== undefined
            ? { key: typeof message.key === 'string' ? Buffer.from(message.key) : message.key }
            : {}),
          ...(message.headers !== undefined ? { headers: message.headers } : {}),
          ...(message.partition !== undefined ? { partition: message.partition } : {}),
          ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
        })),
      );

      return producer.send({
        messages: encoded,
        ...(options.acks !== undefined ? { acks: options.acks } : {}),
      });
    },

    clearSchemaCache(_subject?: string) {
      registry.clearCaches();
    },

    async close() {
      await producer.close();
    },

    async onDestroy() {
      await producer.close();
    },
  };

  return kafkaProducer;
}
