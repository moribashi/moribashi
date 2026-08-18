import { Producer, type ProduceResult } from '@platformatic/kafka';
import { createKafkaClient, type KafkaClient, type SchemaRegistryClient } from './client.js';
import type { KafkaConfigInput } from './config.js';
import { SchemaEncodeError } from './errors.js';
import { subjectForTopic } from './schemas.js';

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
  /** Encoded against the topic's registered value schema. */
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
  /** Drops cached schema ids so the next send re-resolves them. */
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
  /**
   * How long a resolved `subject → schemaId` stays cached, in ms. Default
   * 5 minutes; `0` disables caching.
   */
  schemaCacheTtlMs?: number;
  /** Override the topic → subject derivation. Default `TopicNameStrategy`. */
  subjectFor?: (topic: string) => string;
  /** Test seam. */
  now?: () => number;
}

const DEFAULT_SCHEMA_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  id: number;
  expiresAt: number;
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
  const subjectFor = opts.subjectFor ?? subjectForTopic;
  const now = opts.now ?? Date.now;
  const ttlMs = opts.schemaCacheTtlMs ?? DEFAULT_SCHEMA_CACHE_TTL_MS;

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

  // `subject → schemaId`, bounded by a TTL. An unbounded forever-cache means a
  // registry update is never picked up without a pod restart; the TTL keeps
  // the steady-state cost at one lookup per subject per period, and
  // `clearSchemaCache()` gives callers an explicit invalidation lever.
  const schemaIds = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<number>>();

  async function schemaIdFor(subject: string): Promise<number> {
    const cached = schemaIds.get(subject);
    if (cached && cached.expiresAt > now()) return cached.id;

    // Coalesce concurrent lookups; drop the marker either way so a failure
    // does not poison later sends.
    let pending = inflight.get(subject);
    if (!pending) {
      pending = registry
        .getLatestSchemaId(subject)
        .then(id => {
          if (ttlMs > 0) schemaIds.set(subject, { id, expiresAt: now() + ttlMs });
          return id;
        })
        .finally(() => inflight.delete(subject));
      inflight.set(subject, pending);
    }
    return pending;
  }

  async function encode<T>(message: ProducerMessage<T>): Promise<Buffer> {
    const subject = subjectFor(message.topic);

    let schemaId: number;
    try {
      schemaId = await schemaIdFor(subject);
    } catch (cause) {
      throw new SchemaEncodeError(
        `No schema available for subject "${subject}": ${(cause as Error).message}`,
        message.topic,
        subject,
        undefined,
        { cause },
      );
    }

    try {
      return await registry.encode(schemaId, message.value);
    } catch (cause) {
      throw new SchemaEncodeError(
        `Failed to encode message for topic "${message.topic}": ${(cause as Error).message}`,
        message.topic,
        subject,
        schemaId,
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

    clearSchemaCache(subject?: string) {
      if (subject === undefined) schemaIds.clear();
      else schemaIds.delete(subject);
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
