import { Consumer, Producer, type Message, type MessagesStream } from '@platformatic/kafka';
import { asValue, type MoribashiApp } from '@moribashi/core';
import { createKafkaClient, type KafkaClient, type SchemaRegistryClient } from './client.js';
import type { KafkaConfigInput } from './config.js';
import {
  EventHandlerError,
  KafkaConfigError,
  KafkaError,
  SchemaDecodeError,
} from './errors.js';
import {
  resolveHandlerBindings,
  type HandlerMap,
  type ResolvedHandler,
} from './handlers.js';
import { logError, type Logger } from './schemas.js';
import {
  correlationIdFrom,
  CORRELATION_ID_HEADER,
  EVENT_SCOPE,
  type EventCradle,
  type EventMessage,
  type EventScope,
} from './scope.js';

/** The `@platformatic/kafka` consumer this package builds. */
export type RawConsumer = Consumer<Buffer, Buffer, string, string>;
/** The `@platformatic/kafka` producer used for DLQ routing (raw bytes). */
export type RawDlqProducer = Producer<Buffer, Buffer, string, string>;
type ConsumedMessage = Message<Buffer, Buffer, string, string>;

const passthroughDeserializer = (data?: Buffer): Buffer | undefined => data;
const stringDeserializer = (data?: Buffer): string | undefined => data?.toString('utf8');
const passthroughSerializer = (data?: Buffer): Buffer | undefined => data;
const stringSerializer = (data?: string): Buffer | undefined =>
  data === undefined ? undefined : Buffer.from(data);

/**
 * What to do with a message that could not be processed — decode failure or
 * handler throw, treated identically because both mean "this message cannot
 * move forward".
 *
 * - `'throw'` — stop consuming and fail loudly. See the note on
 *   `CreateConsumerOptions.failurePolicy` before choosing it.
 * - `'skip'` — count it, optionally log it, commit, move on. Data loss by
 *   choice, which is sometimes the right choice.
 * - `{ dlq }` — republish the original bytes to a dead-letter topic with the
 *   failure context in headers, commit, move on.
 */
export type FailurePolicy = 'throw' | 'skip' | { dlq: string };

export interface ConsumerStats {
  /** Messages taken off the stream. */
  received: number;
  /** Handlers that resolved and committed. */
  processed: number;
  /** In-process retry attempts spent (not messages). */
  retried: number;
  /** Messages dropped by the `'skip'` policy. */
  skipped: number;
  /** Messages republished to the DLQ topic. */
  dlq: number;
  /** Messages that ran out of options — fatal under `'throw'`, or a failed DLQ publish. */
  failed: number;
}

/** Prefix for the failure-context headers added to every DLQ message. */
export const DLQ_HEADER_PREFIX = 'x-moribashi-dlq-';

export interface KafkaConsumer {
  /** Joins the group and starts the run loop. Idempotent. */
  start(): Promise<void>;
  /** Stops consuming, drains in-flight messages, disconnects. Idempotent. */
  stop(): Promise<void>;
  /** Topics resolved from the handler bindings. Empty until `start()`. */
  readonly topics: string[];
  /** Live counters — safe to read from a metrics endpoint. */
  readonly stats: Readonly<ConsumerStats>;
  /** Resolves when the run loop ends; rejects with the fatal error under `'throw'`. */
  readonly finished: Promise<void>;
  /** Escape hatch: the underlying `@platformatic/kafka` consumer. */
  readonly consumer: RawConsumer;
  onInit(): Promise<void>;
  onDestroy(): Promise<void>;
}

export interface CreateConsumerOptions {
  /**
   * The app whose container backs the per-message scope. Unlike the producer,
   * the consumer is *not* framework-free: a per-message DI scope is the whole
   * point of it, and scopes come from the app.
   */
  app: MoribashiApp;
  /**
   * Consumer group id. Required, with no derived default — a silently-wrong
   * group id either replays the whole topic or joins someone else's group.
   */
  groupId: string;
  /** BYO client, or config overrides used to build one. */
  client?: KafkaClient | KafkaConfigInput;
  /** BYO registry client. Defaults to the client's. */
  registry?: SchemaRegistryClient;
  /** Explicit topic → handler map. Wins over convention on conflict. */
  handlers?: HandlerMap;
  /** Convention discovery of `*.handler.ts` services. Default `true`. */
  convention?: boolean | RegExp;
  /**
   * Default: `{ dlq }` when `dlq` is set, otherwise `'throw'`.
   *
   * **On `'throw'`**: commits happen *after* the handler resolves, so a throw
   * means the offset is never committed. Propagating it and carrying on would
   * redeliver the same poison message forever — an invisible infinite retry
   * that pins a CPU and never advances. So `'throw'` is defined as *stop
   * consuming*: the run loop ends, `finished` rejects, and `onFatal` fires
   * (crashing the process by default). The partition is wedged either way;
   * this at least makes it a loud, diagnosable outage instead of a silent
   * one. Configure a DLQ and the whole problem goes away.
   */
  failurePolicy?: FailurePolicy;
  /** Shorthand for `failurePolicy: { dlq }`. */
  dlq?: string;
  /** Log every skipped message. Default `true`; turn off for noisy streams. */
  logSkips?: boolean;
  /** In-process retries before the failure policy applies. Default 3; `0` disables. */
  maxRetries?: number;
  /** Base backoff between retries, doubled per attempt. Default 250ms. */
  retryBackoffMs?: number;
  /** Backoff ceiling. Default 5000ms. */
  retryMaxBackoffMs?: number;
  /** Max messages in flight across all partitions. Default 4. */
  concurrency?: number;
  /** Where a group with no committed offsets starts. Default `'earliest'`. */
  fallbackMode?: 'earliest' | 'latest' | 'fail';
  /** Stream start mode. Default `'committed'`. */
  mode?: 'committed' | 'earliest' | 'latest';
  /** Header carrying the correlation id. Default `x-correlation-id`. */
  correlationIdHeader?: string;
  log?: Logger;
  /**
   * Called once when `'throw'` stops the consumer. Default: log, then rethrow
   * on the next tick so the process dies visibly and the pod restarts.
   */
  onFatal?: (error: Error) => void;
  /** Test seams. */
  consumer?: RawConsumer;
  dlqProducer?: RawDlqProducer;
  sleep?: (ms: number) => Promise<void>;
}

const defaultLogger: Logger = {
  warn(obj, msg) {
    console.warn(`[@moribashi/kafka] ${msg}`, obj);
  },
  info() {},
  error(obj, msg) {
    console.error(`[@moribashi/kafka] ${msg}`, obj);
  },
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

function headersOf(message: ConsumedMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of message.headers ?? []) {
    if (typeof key === 'string') headers[key] = value ?? '';
  }
  return headers;
}

/**
 * Builds a schema-aware consumer: decode by schema id, per-message DI scope,
 * at-least-once commit after the handler resolves, bounded retry, and a
 * configurable failure policy.
 *
 * Consumers **never register schemas**. Decoding reads the schema id out of
 * the Confluent framing and looks it up — a read, not a registration. A
 * consumer that registered would be asserting a contract it does not own.
 */
export function createConsumer(opts: CreateConsumerOptions): KafkaConsumer {
  const {
    app,
    groupId,
    handlers,
    convention,
    logSkips = true,
    maxRetries = 3,
    retryBackoffMs = 250,
    retryMaxBackoffMs = 5_000,
    concurrency = 4,
    mode = 'committed',
    fallbackMode = 'earliest',
    correlationIdHeader = CORRELATION_ID_HEADER,
  } = opts;

  if (typeof groupId !== 'string' || groupId.trim() === '') {
    throw new KafkaConfigError(
      'groupId must be a non-empty string — there is deliberately no default.',
    );
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new KafkaConfigError('concurrency must be a positive integer.');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new KafkaConfigError('maxRetries must be a non-negative integer.');
  }

  const client = createKafkaClient(opts.client);
  const registry = opts.registry ?? client.registry;
  const log = opts.log ?? defaultLogger;
  const sleep = opts.sleep ?? defaultSleep;

  const policy: FailurePolicy =
    opts.failurePolicy ?? (opts.dlq ? { dlq: opts.dlq } : 'throw');
  if (typeof policy === 'object' && (typeof policy.dlq !== 'string' || policy.dlq.trim() === '')) {
    throw new KafkaConfigError('failurePolicy.dlq must be a non-empty topic name.');
  }
  if (typeof policy === 'string' && policy !== 'throw' && policy !== 'skip') {
    throw new KafkaConfigError(
      `failurePolicy must be 'throw', 'skip', or { dlq } (got "${policy}").`,
    );
  }
  const dlqTopic = typeof policy === 'object' ? policy.dlq : undefined;

  const rawConsumer: RawConsumer =
    opts.consumer ??
    new Consumer<Buffer, Buffer, string, string>({
      ...client.connectionOptions,
      groupId,
      deserializers: {
        key: passthroughDeserializer,
        value: passthroughDeserializer,
        headerKey: stringDeserializer,
        headerValue: stringDeserializer,
      },
    });

  const dlqProducer: RawDlqProducer | undefined =
    dlqTopic === undefined
      ? undefined
      : (opts.dlqProducer ??
        new Producer<Buffer, Buffer, string, string>({
          ...client.connectionOptions,
          serializers: {
            key: passthroughSerializer,
            value: passthroughSerializer,
            headerKey: stringSerializer,
            headerValue: stringSerializer,
          },
        }));

  const stats: ConsumerStats = {
    received: 0,
    processed: 0,
    retried: 0,
    skipped: 0,
    dlq: 0,
    failed: 0,
  };

  let bindings = new Map<string, ResolvedHandler>();
  let topics: string[] = [];
  let stream: MessagesStream<Buffer, Buffer, string, string> | undefined;
  let loop: Promise<void> | undefined;
  let started = false;
  let stopping = false;
  let fatalError: Error | undefined;
  let releaseSlot: (() => void) | undefined;

  let settleFinished!: () => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => {
    settleFinished = resolve;
    rejectFinished = reject;
  });
  // Guard so a rejected `finished` nobody awaited is not itself an unhandled
  // rejection — `onFatal` is the loud path, this promise is the polite one.
  finished.catch(() => {});

  function defaultOnFatal(error: Error): void {
    logError(
      log,
      { groupId, topics, err: error.message },
      'Consumer stopped: failure policy is "throw" and a message could not be processed. ' +
        'The partition will not advance until this is fixed. Configure a DLQ to avoid this.',
    );
    // Deliberately uncaught: a wedged consumer must not look healthy.
    setImmediate(() => {
      throw error;
    });
  }

  function markFatal(error: Error): void {
    if (fatalError) return;
    fatalError = error;
    stopping = true;
    releaseSlot?.();
    releaseSlot = undefined;
    void stream?.close().catch(() => {});
  }

  function backoffFor(attempt: number): number {
    return Math.min(retryBackoffMs * 2 ** (attempt - 1), retryMaxBackoffMs);
  }

  async function decodeValue(message: ConsumedMessage): Promise<unknown> {
    if (!message.value || message.value.length === 0) return null;
    try {
      return await registry.decode(message.value);
    } catch (cause) {
      throw new SchemaDecodeError(
        `Failed to decode message on "${message.topic}" partition ${message.partition} ` +
          `offset ${message.offset}: ${(cause as Error).message}`,
        message.topic,
        message.partition,
        message.offset,
        { cause },
      );
    }
  }

  async function runHandler(
    binding: ResolvedHandler,
    event: EventMessage,
  ): Promise<void> {
    // A fresh scope per attempt, not per message: a handler that threw
    // halfway may have left scoped services in a half-applied state, and
    // retrying on top of that is how one bug becomes two.
    const scope = app.createScope<EventCradle>(EVENT_SCOPE);
    scope.container.register({
      event: asValue(event),
      correlationId: asValue(event.correlationId),
    });
    try {
      await binding.handle(event, scope as EventScope);
    } finally {
      // The app may already have disposed it during app.stop().
      await scope.dispose().catch(() => {});
    }
  }

  async function commitMessage(message: ConsumedMessage): Promise<void> {
    try {
      await message.commit();
    } catch (cause) {
      // At-least-once: the work is done but the offset is not recorded, so
      // this message will be redelivered. Loud, but not fatal.
      logError(
        log,
        {
          topic: message.topic,
          partition: message.partition,
          offset: String(message.offset),
          err: (cause as Error).message,
        },
        'Commit failed — message will be redelivered (handlers must be idempotent)',
      );
    }
  }

  async function publishToDlq(
    message: ConsumedMessage,
    error: Error,
    attempts: number,
  ): Promise<void> {
    // The original bytes go through untouched. Re-encoding a message that
    // failed to decode is impossible, and re-encoding one that failed in the
    // handler would hide what actually arrived.
    await dlqProducer!.send({
      messages: [
        {
          topic: dlqTopic!,
          value: message.value,
          ...(message.key?.length ? { key: message.key } : {}),
          headers: {
            ...headersOf(message),
            [`${DLQ_HEADER_PREFIX}original-topic`]: message.topic,
            [`${DLQ_HEADER_PREFIX}original-partition`]: String(message.partition),
            [`${DLQ_HEADER_PREFIX}original-offset`]: String(message.offset),
            [`${DLQ_HEADER_PREFIX}error`]: error.message,
            [`${DLQ_HEADER_PREFIX}error-name`]: error.name,
            [`${DLQ_HEADER_PREFIX}attempts`]: String(attempts),
            [`${DLQ_HEADER_PREFIX}group-id`]: groupId,
            [`${DLQ_HEADER_PREFIX}timestamp`]: new Date().toISOString(),
          },
        },
      ],
    });
  }

  async function applyFailurePolicy(
    message: ConsumedMessage,
    error: Error,
    attempts: number,
  ): Promise<void> {
    const context = {
      topic: message.topic,
      partition: message.partition,
      offset: String(message.offset),
      attempts,
      err: error.message,
    };

    if (policy === 'throw') {
      stats.failed++;
      throw error;
    }

    if (policy === 'skip') {
      stats.skipped++;
      if (logSkips) logError(log, context, 'Skipping message after failure');
      await commitMessage(message);
      return;
    }

    try {
      await publishToDlq(message, error, attempts);
      stats.dlq++;
      logError(log, { ...context, dlq: dlqTopic }, 'Routed message to DLQ');
    } catch (cause) {
      stats.failed++;
      // A failing DLQ is a second failure. Swallowing it would drop the
      // message silently, which is the one outcome nobody asked for.
      throw new EventHandlerError(
        `Failed to route message to DLQ topic "${dlqTopic}": ${(cause as Error).message}. ` +
          'Is the DLQ topic declared? The cluster does not auto-create topics.',
        message.topic,
        message.partition,
        message.offset,
        attempts,
        { cause },
      );
    }
    await commitMessage(message);
  }

  async function processMessage(message: ConsumedMessage): Promise<void> {
    // Work that was queued behind a lane but never started is abandoned once
    // we are stopping. Under `'throw'` this is load-bearing: committing a
    // later offset in the same partition would skip *past* the uncommitted
    // poison message and lose it silently. Abandoned messages are simply
    // redelivered — that is what at-least-once buys.
    if (fatalError || stopping) return;

    stats.received++;

    const binding = bindings.get(message.topic);
    if (!binding) {
      await applyFailurePolicy(
        message,
        new EventHandlerError(
          `No handler bound for topic "${message.topic}".`,
          message.topic,
          message.partition,
          message.offset,
          0,
        ),
        0,
      );
      return;
    }

    const headers = headersOf(message);
    const correlationId = correlationIdFrom(headers, correlationIdHeader);
    const rawKey = message.key?.length ? message.key : undefined;
    const totalAttempts = maxRetries + 1;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      if (stopping && attempt > 1) break;
      try {
        const value = await decodeValue(message);
        const event: EventMessage = {
          topic: message.topic,
          partition: message.partition,
          offset: message.offset,
          ...(rawKey ? { key: rawKey.toString('utf8'), rawKey } : {}),
          value,
          ...(message.value ? { rawValue: message.value } : {}),
          headers,
          ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
          correlationId,
          attempt,
        };

        await runHandler(binding, event);
        stats.processed++;
        // At-least-once: commit only once the handler has resolved.
        await commitMessage(message);
        return;
      } catch (cause) {
        lastError =
          cause instanceof KafkaError
            ? cause
            : new EventHandlerError(
                `Handler "${binding.name}" failed for "${message.topic}" partition ` +
                  `${message.partition} offset ${message.offset}: ${(cause as Error).message}`,
                message.topic,
                message.partition,
                message.offset,
                attempt,
                { cause },
              );

        if (attempt < totalAttempts && !stopping) {
          stats.retried++;
          log.warn(
            {
              topic: message.topic,
              partition: message.partition,
              offset: String(message.offset),
              attempt,
              err: lastError.message,
            },
            'Handler failed, retrying',
          );
          await sleep(backoffFor(attempt));
        }
      }
    }

    await applyFailurePolicy(message, lastError!, totalAttempts);
  }

  async function runLoop(
    source: MessagesStream<Buffer, Buffer, string, string>,
  ): Promise<void> {
    // One lane per partition: sequential within a lane because ordering is
    // the entire point of the partition key, parallel across lanes, and
    // globally bounded by `concurrency` so a slow handler cannot fan out.
    const lanes = new Map<string, Promise<void>>();
    let inFlight = 0;

    try {
      for await (const message of source) {
        if (stopping) break;

        const lane = `${message.topic}:${message.partition}`;
        const previous = lanes.get(lane) ?? Promise.resolve();
        inFlight++;

        const task = previous
          .then(() => processMessage(message))
          .catch(error => markFatal(error as Error))
          .finally(() => {
            inFlight--;
            releaseSlot?.();
            releaseSlot = undefined;
          });

        lanes.set(lane, task);

        if (inFlight >= concurrency) {
          await new Promise<void>(resolve => {
            releaseSlot = resolve;
          });
        }
      }
    } finally {
      await Promise.allSettled([...lanes.values()]);
    }

    if (fatalError) {
      (opts.onFatal ?? defaultOnFatal)(fatalError);
      rejectFinished(fatalError);
      return;
    }
    settleFinished();
  }

  const kafkaConsumer: KafkaConsumer = {
    get consumer() {
      return rawConsumer;
    },
    get topics() {
      return topics;
    },
    get stats() {
      return stats;
    },
    get finished() {
      return finished;
    },

    async start() {
      if (started) return;
      started = true;

      // Resolved here rather than at plugin `register()` so a service can
      // `app.scan()` its handlers after `app.use()`.
      bindings = resolveHandlerBindings({ app, handlers, convention, log });
      topics = [...bindings.keys()].sort();
      log.info({ groupId, topics, policy: dlqTopic ?? policy }, 'Starting consumer');

      stream = await rawConsumer.consume({
        topics,
        mode,
        fallbackMode,
        // Never autocommit: the whole at-least-once story is that the offset
        // moves only after the handler resolved. @platformatic/kafka defaults
        // this to true, so it must be turned off explicitly.
        autocommit: false,
      });

      loop = runLoop(stream);
    },

    async stop() {
      if (!started) {
        await rawConsumer.close().catch(() => {});
        await dlqProducer?.close().catch(() => {});
        return;
      }
      stopping = true;
      releaseSlot?.();
      releaseSlot = undefined;
      await stream?.close().catch(() => {});
      await loop?.catch(() => {});
      await rawConsumer.close().catch(() => {});
      await dlqProducer?.close().catch(() => {});
      started = false;
    },

    async onInit() {
      await this.start();
    },

    async onDestroy() {
      await this.stop();
    },
  };

  return kafkaConsumer;
}
