import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createApp, type MoribashiApp } from '@moribashi/core';
import {
  createConsumer,
  DLQ_HEADER_PREFIX,
  EVENT_SCOPE,
  EventHandlerError,
  KafkaConfigError,
  SchemaDecodeError,
  type CreateConsumerOptions,
  type EventMessage,
  type EventScope,
  type Logger,
} from '../index.js';
import type { RawConsumer, RawDlqProducer } from '../consumer.js';
import {
  baseConfig,
  clearKafkaEnv,
  fakeClient,
  fakeMessage,
  fakeRawConsumer,
  fakeRawProducer,
  fakeRegistry,
  fakeStream,
  type FakeConsumedMessage,
  type RegistryStubs,
} from './helpers.js';

const savedEnv = { ...process.env };

beforeEach(() => clearKafkaEnv());
afterEach(() => {
  process.env = { ...savedEnv };
});

interface SetupOptions {
  messages?: FakeConsumedMessage[];
  registry?: Partial<RegistryStubs>;
  handler?: (event: EventMessage, scope: EventScope) => void | Promise<void>;
  app?: MoribashiApp;
  consumer?: Partial<CreateConsumerOptions>;
}

function setup(opts: SetupOptions = {}) {
  const messages = opts.messages ?? [fakeMessage()];
  const app = opts.app ?? createApp();
  const registry = fakeRegistry({
    decode: vi.fn(async () => ({ ok: true })),
    ...opts.registry,
  });
  const stream = fakeStream(messages);
  const raw = fakeRawConsumer(stream);
  const dlqProducer = fakeRawProducer();
  const logs: Array<{ level: string; obj: Record<string, unknown>; msg: string }> = [];
  const log: Logger = {
    warn: (obj, msg) => void logs.push({ level: 'warn', obj, msg }),
    info: (obj, msg) => void logs.push({ level: 'info', obj, msg }),
    error: (obj, msg) => void logs.push({ level: 'error', obj, msg }),
  };
  const fatals: Error[] = [];
  const handle = vi.fn(opts.handler ?? (() => {}));

  const consumer = createConsumer({
    app,
    groupId: 'test-group',
    client: fakeClient(baseConfig, registry),
    handlers: { t: handle },
    convention: false,
    consumer: raw as unknown as RawConsumer,
    dlqProducer: dlqProducer as unknown as RawDlqProducer,
    log,
    sleep: async () => {},
    onFatal: error => void fatals.push(error),
    ...opts.consumer,
  });

  return { app, consumer, registry, raw, stream, dlqProducer, handle, logs, fatals, messages };
}

/** Start, let the (finite) fake stream drain, and swallow a fatal rejection. */
async function drain(consumer: ReturnType<typeof setup>['consumer']) {
  await consumer.start();
  await consumer.finished.catch(() => {});
}

describe('createConsumer — configuration', () => {
  it('requires a non-empty groupId', () => {
    expect(() =>
      createConsumer({ app: createApp(), groupId: '  ', client: fakeClient() }),
    ).toThrow(KafkaConfigError);
  });

  it('says the group id has no default', () => {
    expect(() =>
      createConsumer({ app: createApp(), groupId: '', client: fakeClient() }),
    ).toThrow(/no default/);
  });

  it.each([0, -1, 1.5])('rejects concurrency %s', value => {
    expect(() =>
      createConsumer({
        app: createApp(),
        groupId: 'g',
        client: fakeClient(),
        concurrency: value,
      }),
    ).toThrow(/concurrency/);
  });

  it('rejects a negative maxRetries', () => {
    expect(() =>
      createConsumer({ app: createApp(), groupId: 'g', client: fakeClient(), maxRetries: -1 }),
    ).toThrow(/maxRetries/);
  });

  it('rejects an empty DLQ topic', () => {
    expect(() =>
      createConsumer({ app: createApp(), groupId: 'g', client: fakeClient(), dlq: '  ' }),
    ).toThrow(/dlq/);
  });

  it('rejects an unknown failure policy', () => {
    expect(() =>
      createConsumer({
        app: createApp(),
        groupId: 'g',
        client: fakeClient(),
        failurePolicy: 'retry' as never,
      }),
    ).toThrow(/'throw', 'skip', or \{ dlq \}/);
  });

  it('validates client config eagerly', () => {
    expect(() =>
      createConsumer({ app: createApp(), groupId: 'g', client: { clientId: 'only' } }),
    ).toThrow(/KAFKA_BROKERS/);
  });
});

describe('subscription and commit semantics', () => {
  it('subscribes to exactly the bound topics, sorted', async () => {
    const { consumer, raw } = setup({
      consumer: { handlers: { zebra: () => {}, alpha: () => {} } },
      messages: [],
    });

    await drain(consumer);

    expect(raw.lastConsumeOptions?.topics).toEqual(['alpha', 'zebra']);
    expect(consumer.topics).toEqual(['alpha', 'zebra']);
  });

  it('disables autocommit — @platformatic/kafka defaults it to true', async () => {
    const { consumer, raw } = setup({ messages: [] });

    await drain(consumer);

    expect(raw.lastConsumeOptions?.autocommit).toBe(false);
  });

  it('starts from committed offsets and falls back to earliest', async () => {
    const { consumer, raw } = setup({ messages: [] });

    await drain(consumer);

    expect(raw.lastConsumeOptions).toMatchObject({ mode: 'committed', fallbackMode: 'earliest' });
  });

  it('commits only after the handler resolves', async () => {
    const order: string[] = [];
    const message = fakeMessage();
    message.commit = vi.fn(async () => void order.push('commit'));

    const { consumer } = setup({
      messages: [message],
      handler: async () => {
        order.push('handler-start');
        await Promise.resolve();
        order.push('handler-end');
      },
    });

    await drain(consumer);

    expect(order).toEqual(['handler-start', 'handler-end', 'commit']);
  });

  it('does not commit when the handler throws under the throw policy', async () => {
    const message = fakeMessage();
    const { consumer } = setup({
      messages: [message],
      handler: () => {
        throw new Error('boom');
      },
      consumer: { maxRetries: 0 },
    });

    await drain(consumer);

    expect(message.commit).not.toHaveBeenCalled();
  });

  it('logs a failed commit but does not treat it as fatal', async () => {
    const message = fakeMessage();
    message.commit = vi.fn(async () => {
      throw new Error('rebalance in progress');
    });

    const { consumer, logs, fatals } = setup({ messages: [message] });

    await drain(consumer);

    expect(fatals).toHaveLength(0);
    expect(logs.some(l => /redelivered/.test(l.msg))).toBe(true);
    expect(consumer.stats.processed).toBe(1);
  });
});

describe('decoding and the event', () => {
  it('decodes the value off the wire and passes it to the handler', async () => {
    const { consumer, registry, handle } = setup({
      registry: { decode: vi.fn(async () => ({ id: 'a1' })) },
      messages: [fakeMessage({ value: Buffer.from([0, 0, 0, 0, 1, 9]) })],
    });

    await drain(consumer);

    // Topic-scoped: the deserializer derives the subject from it, then
    // resolves the writer's schema from the id in the framing.
    expect(registry.decode).toHaveBeenCalledWith('t', Buffer.from([0, 0, 0, 0, 1, 9]));
    expect(handle.mock.calls[0][0]).toMatchObject({ value: { id: 'a1' } });
  });

  it('never registers a schema — decode is a lookup, not a registration', async () => {
    const { consumer, registry } = setup();

    await drain(consumer);

    expect(registry.register).not.toHaveBeenCalled();
  });

  it('carries the Kafka coordinates on the event', async () => {
    const { consumer, handle } = setup({
      messages: [
        fakeMessage({ topic: 't', partition: 3, offset: 99n, timestamp: 1234n }),
      ],
    });

    await drain(consumer);

    expect(handle.mock.calls[0][0]).toMatchObject({
      topic: 't',
      partition: 3,
      offset: 99n,
      timestamp: 1234n,
      attempt: 1,
    });
  });

  it('exposes the key as UTF-8 and as raw bytes', async () => {
    const key = Buffer.from('tenant-a');
    const { consumer, handle } = setup({ messages: [fakeMessage({ key })] });

    await drain(consumer);

    const event = handle.mock.calls[0][0] as EventMessage;
    expect(event.key).toBe('tenant-a');
    expect(event.rawKey).toBe(key);
  });

  it('omits the key when the message has none', async () => {
    const { consumer, handle } = setup({ messages: [fakeMessage({ key: undefined })] });

    await drain(consumer);

    expect(handle.mock.calls[0][0]).not.toHaveProperty('key');
  });

  it('exposes headers as a plain object', async () => {
    const { consumer, handle } = setup({
      messages: [fakeMessage({ headers: { 'trace-id': 'abc' } })],
    });

    await drain(consumer);

    expect((handle.mock.calls[0][0] as EventMessage).headers).toEqual({ 'trace-id': 'abc' });
  });

  it('treats a tombstone (empty value) as null without calling the registry', async () => {
    const { consumer, registry, handle } = setup({
      messages: [fakeMessage({ value: Buffer.alloc(0) })],
    });

    await drain(consumer);

    expect(registry.decode).not.toHaveBeenCalled();
    expect(handle.mock.calls[0][0]).toMatchObject({ value: null });
  });
});

describe('correlation id', () => {
  it('takes it from the x-correlation-id header', async () => {
    const { consumer, handle } = setup({
      messages: [fakeMessage({ headers: { 'x-correlation-id': 'corr-1' } })],
    });

    await drain(consumer);

    expect((handle.mock.calls[0][0] as EventMessage).correlationId).toBe('corr-1');
  });

  it('matches the header case-insensitively', async () => {
    const { consumer, handle } = setup({
      messages: [fakeMessage({ headers: { 'X-Correlation-Id': 'corr-2' } })],
    });

    await drain(consumer);

    expect((handle.mock.calls[0][0] as EventMessage).correlationId).toBe('corr-2');
  });

  it('generates one when the header is absent', async () => {
    const { consumer, handle } = setup({ messages: [fakeMessage({ headers: {} })] });

    await drain(consumer);

    expect((handle.mock.calls[0][0] as EventMessage).correlationId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
  });

  it('honours a custom header name', async () => {
    const { consumer, handle } = setup({
      messages: [fakeMessage({ headers: { 'x-request-id': 'req-9' } })],
      consumer: { correlationIdHeader: 'x-request-id' },
    });

    await drain(consumer);

    expect((handle.mock.calls[0][0] as EventMessage).correlationId).toBe('req-9');
  });
});

class Tracker {
  static created = 0;
  static destroyed = 0;
  readonly event: EventMessage;
  constructor({ event }: { event: EventMessage }) {
    Tracker.created++;
    this.event = event;
  }
  onDestroy() {
    Tracker.destroyed++;
  }
}

// Exactly the augmentation a consuming service writes, except pointed at the
// source module instead of the published package name.
declare module '../scope.js' {
  interface EventCradle {
    tracker: Tracker;
  }
}

describe('per-message DI scope', () => {
  beforeEach(() => {
    Tracker.created = 0;
    Tracker.destroyed = 0;
  });

  it('gives the handler a scope carrying the event and correlation id', async () => {
    let seen: { topic: string; correlationId: string } | undefined;
    const { consumer } = setup({
      messages: [fakeMessage({ headers: { 'x-correlation-id': 'corr-1' } })],
      handler: (_event, scope) => {
        seen = {
          topic: scope.resolve<EventMessage>('event').topic,
          correlationId: scope.resolve<string>('correlationId'),
        };
      },
    });

    await drain(consumer);

    expect(seen).toEqual({ topic: 't', correlationId: 'corr-1' });
  });

  it('injects the event into scoped services registered by the app', async () => {
    const app = createApp();
    app.registerInScope(EVENT_SCOPE, { tracker: Tracker });
    let offset: bigint | undefined;

    const { consumer } = setup({
      app,
      messages: [fakeMessage({ offset: 77n })],
      handler: (_event, scope) => {
        offset = scope.cradle.tracker.event.offset;
      },
    });

    await drain(consumer);

    expect(offset).toBe(77n);
  });

  it('creates one scope per message and disposes each', async () => {
    const app = createApp();
    app.registerInScope(EVENT_SCOPE, { tracker: Tracker });

    const { consumer } = setup({
      app,
      messages: [fakeMessage(), fakeMessage(), fakeMessage()],
      handler: (_event, scope) => void scope.cradle.tracker,
    });

    await drain(consumer);

    expect(Tracker.created).toBe(3);
    expect(Tracker.destroyed).toBe(3);
  });

  it('disposes the scope even when the handler throws', async () => {
    const app = createApp();
    app.registerInScope(EVENT_SCOPE, { tracker: Tracker });

    const { consumer } = setup({
      app,
      handler: (_event, scope) => {
        void scope.cradle.tracker;
        throw new Error('boom');
      },
      consumer: { maxRetries: 0, failurePolicy: 'skip' },
    });

    await drain(consumer);

    expect(Tracker.created).toBe(1);
    expect(Tracker.destroyed).toBe(1);
  });

  it('gives each retry attempt a fresh scope', async () => {
    const app = createApp();
    app.registerInScope(EVENT_SCOPE, { tracker: Tracker });
    let attempts = 0;

    const { consumer } = setup({
      app,
      handler: (_event, scope) => {
        void scope.cradle.tracker;
        if (++attempts < 3) throw new Error('transient');
      },
      consumer: { maxRetries: 3 },
    });

    await drain(consumer);

    // A handler that threw halfway may have left scoped state half-applied;
    // retrying on top of it is how one bug becomes two.
    expect(Tracker.created).toBe(3);
    expect(Tracker.destroyed).toBe(3);
  });

  it('does not leave scopes behind for the app to clean up', async () => {
    const app = createApp();
    const { consumer } = setup({ app, messages: [fakeMessage(), fakeMessage()] });

    await drain(consumer);
    // If a scope leaked, app.stop() would still be holding it.
    await expect(app.stop()).resolves.toBeUndefined();
  });
});

describe('retry', () => {
  it('retries a throwing handler up to maxRetries', async () => {
    let calls = 0;
    const { consumer } = setup({
      handler: () => {
        calls++;
        throw new Error('transient');
      },
      consumer: { maxRetries: 3, failurePolicy: 'skip' },
    });

    await drain(consumer);

    expect(calls).toBe(4); // 1 attempt + 3 retries
    expect(consumer.stats.retried).toBe(3);
  });

  it('stops retrying as soon as the handler succeeds', async () => {
    let calls = 0;
    const { consumer } = setup({
      handler: () => {
        if (++calls < 2) throw new Error('transient');
      },
    });

    await drain(consumer);

    expect(calls).toBe(2);
    expect(consumer.stats.processed).toBe(1);
    expect(consumer.stats.skipped).toBe(0);
  });

  it('reports the attempt number on the event', async () => {
    const attempts: number[] = [];
    const { consumer } = setup({
      handler: event => {
        attempts.push(event.attempt);
        if (event.attempt < 3) throw new Error('transient');
      },
    });

    await drain(consumer);

    expect(attempts).toEqual([1, 2, 3]);
  });

  it('maxRetries: 0 disables retrying', async () => {
    let calls = 0;
    const { consumer } = setup({
      handler: () => {
        calls++;
        throw new Error('boom');
      },
      consumer: { maxRetries: 0, failurePolicy: 'skip' },
    });

    await drain(consumer);

    expect(calls).toBe(1);
    expect(consumer.stats.retried).toBe(0);
  });

  it('backs off exponentially up to the ceiling', async () => {
    const delays: number[] = [];
    const { consumer } = setup({
      handler: () => {
        throw new Error('boom');
      },
      consumer: {
        maxRetries: 5,
        retryBackoffMs: 100,
        retryMaxBackoffMs: 400,
        failurePolicy: 'skip',
        sleep: async ms => void delays.push(ms),
      },
    });

    await drain(consumer);

    expect(delays).toEqual([100, 200, 400, 400, 400]);
  });

  it('retries decode failures too — a registry blip should not reach the DLQ', async () => {
    let calls = 0;
    const { consumer, handle } = setup({
      registry: {
        decode: vi.fn(async () => {
          if (++calls < 3) throw new Error('registry unreachable');
          return { ok: true };
        }),
      },
    });

    await drain(consumer);

    expect(calls).toBe(3);
    expect(handle).toHaveBeenCalledOnce();
    expect(consumer.stats.processed).toBe(1);
  });
});

describe("failure policy: 'skip'", () => {
  it('is a one-liner that commits and moves on', async () => {
    const messages = [fakeMessage(), fakeMessage()];
    const { consumer } = setup({
      messages,
      handler: event => {
        if (event.offset === messages[0].offset) throw new Error('poison');
      },
      consumer: { failurePolicy: 'skip', maxRetries: 0 },
    });

    await drain(consumer);

    expect(messages[0].commit).toHaveBeenCalledOnce();
    expect(messages[1].commit).toHaveBeenCalledOnce();
    expect(consumer.stats).toMatchObject({ skipped: 1, processed: 1 });
  });

  it('logs the skip by default', async () => {
    const { consumer, logs } = setup({
      handler: () => {
        throw new Error('poison');
      },
      consumer: { failurePolicy: 'skip', maxRetries: 0 },
    });

    await drain(consumer);

    expect(logs.some(l => l.msg.includes('Skipping message'))).toBe(true);
  });

  it('still counts the skip when logging is off', async () => {
    const { consumer, logs } = setup({
      handler: () => {
        throw new Error('poison');
      },
      consumer: { failurePolicy: 'skip', maxRetries: 0, logSkips: false },
    });

    await drain(consumer);

    expect(logs.some(l => l.msg.includes('Skipping message'))).toBe(false);
    expect(consumer.stats.skipped).toBe(1);
  });

  it('skips undecodable messages as well as failing handlers', async () => {
    const { consumer, handle } = setup({
      registry: {
        decode: vi.fn(async () => {
          throw new Error('unknown schema id');
        }),
      },
      consumer: { failurePolicy: 'skip', maxRetries: 0 },
    });

    await drain(consumer);

    expect(handle).not.toHaveBeenCalled();
    expect(consumer.stats.skipped).toBe(1);
  });
});

describe("failure policy: { dlq }", () => {
  it('is the default once a DLQ topic is configured', async () => {
    const { consumer, dlqProducer } = setup({
      handler: () => {
        throw new Error('poison');
      },
      consumer: { dlq: 'iam.dlq.v1', maxRetries: 0 },
    });

    await drain(consumer);

    expect(dlqProducer.send).toHaveBeenCalledOnce();
    expect(consumer.stats.dlq).toBe(1);
  });

  it('republishes the original bytes, not a re-encoded payload', async () => {
    const value = Buffer.from([0, 0, 0, 0, 7, 42]);
    const key = Buffer.from('tenant-a');
    const { consumer, dlqProducer } = setup({
      messages: [fakeMessage({ value, key })],
      handler: () => {
        throw new Error('poison');
      },
      consumer: { dlq: 'dlq.v1', maxRetries: 0 },
    });

    await drain(consumer);

    const [sent] = dlqProducer.send.mock.calls[0][0].messages;
    expect(sent.topic).toBe('dlq.v1');
    expect(sent.value).toBe(value);
    expect(sent.key).toBe(key);
  });

  it('routes an undecodable message through with its raw bytes intact', async () => {
    const value = Buffer.from('not-confluent-framed');
    const { consumer, dlqProducer } = setup({
      messages: [fakeMessage({ value })],
      registry: {
        decode: vi.fn(async () => {
          throw new Error('unknown magic byte');
        }),
      },
      consumer: { dlq: 'dlq.v1', maxRetries: 0 },
    });

    await drain(consumer);

    // Re-encoding something that failed to decode is impossible; the DLQ gets
    // exactly what arrived.
    expect(dlqProducer.send.mock.calls[0][0].messages[0].value).toBe(value);
  });

  it('attaches the failure context as headers', async () => {
    const { consumer, dlqProducer } = setup({
      messages: [fakeMessage({ topic: 't', partition: 2, offset: 55n })],
      handler: () => {
        throw new Error('poison pill');
      },
      consumer: { dlq: 'dlq.v1', maxRetries: 1 },
    });

    await drain(consumer);

    const headers = dlqProducer.send.mock.calls[0][0].messages[0].headers;
    expect(headers).toMatchObject({
      [`${DLQ_HEADER_PREFIX}original-topic`]: 't',
      [`${DLQ_HEADER_PREFIX}original-partition`]: '2',
      [`${DLQ_HEADER_PREFIX}original-offset`]: '55',
      [`${DLQ_HEADER_PREFIX}error-name`]: 'EventHandlerError',
      [`${DLQ_HEADER_PREFIX}attempts`]: '2',
      [`${DLQ_HEADER_PREFIX}group-id`]: 'test-group',
    });
    expect(headers[`${DLQ_HEADER_PREFIX}error`]).toMatch(/poison pill/);
  });

  it('preserves the original headers alongside the failure context', async () => {
    const { consumer, dlqProducer } = setup({
      messages: [fakeMessage({ headers: { 'trace-id': 'abc' } })],
      handler: () => {
        throw new Error('poison');
      },
      consumer: { dlq: 'dlq.v1', maxRetries: 0 },
    });

    await drain(consumer);

    expect(dlqProducer.send.mock.calls[0][0].messages[0].headers['trace-id']).toBe('abc');
  });

  it('commits after routing, so the partition advances', async () => {
    const message = fakeMessage();
    const { consumer } = setup({
      messages: [message],
      handler: () => {
        throw new Error('poison');
      },
      consumer: { dlq: 'dlq.v1', maxRetries: 0 },
    });

    await drain(consumer);

    expect(message.commit).toHaveBeenCalledOnce();
  });

  it('a failing DLQ publish is fatal — a silently dropped message is worse', async () => {
    const { consumer, dlqProducer, fatals, messages } = setup({
      handler: () => {
        throw new Error('poison');
      },
      consumer: { dlq: 'dlq.v1', maxRetries: 0 },
    });
    dlqProducer.send.mockRejectedValue(new Error('UNKNOWN_TOPIC_OR_PARTITION'));

    await drain(consumer);

    expect(fatals[0]).toBeInstanceOf(EventHandlerError);
    expect(fatals[0].message).toMatch(/does not auto-create topics/);
    expect(messages[0].commit).not.toHaveBeenCalled();
    expect(consumer.stats.failed).toBe(1);
  });

  it('an explicit failurePolicy beats the dlq shorthand', async () => {
    const { consumer, dlqProducer } = setup({
      handler: () => {
        throw new Error('poison');
      },
      consumer: { dlq: 'dlq.v1', failurePolicy: 'skip', maxRetries: 0 },
    });

    await drain(consumer);

    expect(dlqProducer.send).not.toHaveBeenCalled();
    expect(consumer.stats.skipped).toBe(1);
  });
});

describe("failure policy: 'throw'", () => {
  it('is the default when no DLQ is configured', async () => {
    const { consumer, fatals } = setup({
      handler: () => {
        throw new Error('poison');
      },
      consumer: { maxRetries: 0 },
    });

    await drain(consumer);

    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toBeInstanceOf(EventHandlerError);
  });

  it('stops consuming rather than redelivering the poison message forever', async () => {
    const messages = [fakeMessage({ partition: 0 }), fakeMessage({ partition: 0 })];
    const { consumer, handle, stream } = setup({
      messages,
      handler: () => {
        throw new Error('poison');
      },
      consumer: { maxRetries: 0 },
    });

    await drain(consumer);

    // The lane is wedged on purpose: the alternative is an invisible infinite
    // retry that pins a CPU and never advances. The second message on the same
    // partition must NOT be processed — committing it would skip past the
    // uncommitted poison message and lose it.
    expect(handle).toHaveBeenCalledOnce();
    expect(messages[1].commit).not.toHaveBeenCalled();
    expect(stream.close).toHaveBeenCalled();
  });

  it('rejects `finished` with the fatal error', async () => {
    const { consumer } = setup({
      handler: () => {
        throw new Error('poison');
      },
      consumer: { maxRetries: 0 },
    });

    await consumer.start();

    await expect(consumer.finished).rejects.toBeInstanceOf(EventHandlerError);
  });

  it('surfaces a decode failure as fatal too', async () => {
    const { consumer, fatals } = setup({
      registry: {
        decode: vi.fn(async () => {
          throw new Error('unknown schema id');
        }),
      },
      consumer: { maxRetries: 0 },
    });

    await drain(consumer);

    expect(fatals[0]).toBeInstanceOf(SchemaDecodeError);
  });

  it('does not commit the poison message', async () => {
    const { consumer, messages } = setup({
      handler: () => {
        throw new Error('poison');
      },
      consumer: { maxRetries: 0 },
    });

    await drain(consumer);

    expect(messages[0].commit).not.toHaveBeenCalled();
  });

  it('reports only the first fatal, not one per in-flight message', async () => {
    const { consumer, fatals } = setup({
      messages: [fakeMessage({ partition: 0 }), fakeMessage({ partition: 1 })],
      handler: () => {
        throw new Error('poison');
      },
      consumer: { maxRetries: 0 },
    });

    await drain(consumer);

    expect(fatals).toHaveLength(1);
  });
});

describe('unbound topics', () => {
  it('routes a message for an unbound topic through the failure policy', async () => {
    const { consumer, dlqProducer } = setup({
      messages: [fakeMessage({ topic: 'unexpected' })],
      consumer: { dlq: 'dlq.v1' },
    });

    await drain(consumer);

    expect(dlqProducer.send).toHaveBeenCalledOnce();
    expect(dlqProducer.send.mock.calls[0][0].messages[0].headers[`${DLQ_HEADER_PREFIX}error`])
      .toMatch(/No handler bound/);
  });

  it('does not retry an unbound topic — retrying cannot bind it', async () => {
    const { consumer } = setup({
      messages: [fakeMessage({ topic: 'unexpected' })],
      consumer: { failurePolicy: 'skip' },
    });

    await drain(consumer);

    expect(consumer.stats.retried).toBe(0);
    expect(consumer.stats.skipped).toBe(1);
  });
});

describe('concurrency', () => {
  function trackingHandler() {
    const active = new Map<number, number>();
    let maxTotal = 0;
    let maxPerPartition = 0;
    const order: string[] = [];

    const handler = async (event: EventMessage) => {
      const running = (active.get(event.partition) ?? 0) + 1;
      active.set(event.partition, running);
      maxPerPartition = Math.max(maxPerPartition, running);
      maxTotal = Math.max(maxTotal, [...active.values()].reduce((a, b) => a + b, 0));
      order.push(`${event.partition}:${event.offset}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      active.set(event.partition, (active.get(event.partition) ?? 1) - 1);
    };

    return {
      handler,
      get maxTotal() {
        return maxTotal;
      },
      get maxPerPartition() {
        return maxPerPartition;
      },
      order,
    };
  }

  it('never runs two messages from one partition at once', async () => {
    const tracker = trackingHandler();
    const { consumer } = setup({
      messages: [0, 1, 2, 3].map(i => fakeMessage({ partition: 0, offset: BigInt(i) })),
      handler: tracker.handler,
    });

    await drain(consumer);

    expect(tracker.maxPerPartition).toBe(1);
  });

  it('preserves order within a partition — the point of the key', async () => {
    const tracker = trackingHandler();
    const { consumer } = setup({
      messages: [0, 1, 2, 3].map(i => fakeMessage({ partition: 0, offset: BigInt(i) })),
      handler: tracker.handler,
    });

    await drain(consumer);

    expect(tracker.order).toEqual(['0:0', '0:1', '0:2', '0:3']);
  });

  it('processes different partitions in parallel', async () => {
    const tracker = trackingHandler();
    const { consumer } = setup({
      messages: [0, 1, 2, 3].map(i => fakeMessage({ partition: i, offset: 0n })),
      handler: tracker.handler,
      consumer: { concurrency: 4 },
    });

    await drain(consumer);

    expect(tracker.maxTotal).toBeGreaterThan(1);
  });

  it('bounds total parallelism', async () => {
    const tracker = trackingHandler();
    const { consumer } = setup({
      messages: Array.from({ length: 8 }, (_, i) => fakeMessage({ partition: i, offset: 0n })),
      handler: tracker.handler,
      consumer: { concurrency: 2 },
    });

    await drain(consumer);

    expect(tracker.maxTotal).toBeLessThanOrEqual(2);
  });

  it('concurrency 1 serializes everything', async () => {
    const tracker = trackingHandler();
    const { consumer } = setup({
      messages: Array.from({ length: 4 }, (_, i) => fakeMessage({ partition: i, offset: 0n })),
      handler: tracker.handler,
      consumer: { concurrency: 1 },
    });

    await drain(consumer);

    expect(tracker.maxTotal).toBe(1);
  });
});

describe('lifecycle', () => {
  it('start() joins the group', async () => {
    const { consumer, raw } = setup({ messages: [] });

    await drain(consumer);

    expect(raw.consume).toHaveBeenCalledOnce();
  });

  it('start() is idempotent', async () => {
    const { consumer, raw } = setup({ messages: [] });

    await consumer.start();
    await consumer.start();
    await consumer.finished;

    expect(raw.consume).toHaveBeenCalledOnce();
  });

  it('onInit() starts and onDestroy() stops', async () => {
    const { consumer, raw, stream } = setup({ messages: [] });

    await consumer.onInit();
    await consumer.onDestroy();

    expect(raw.consume).toHaveBeenCalledOnce();
    expect(stream.close).toHaveBeenCalled();
    expect(raw.close).toHaveBeenCalled();
  });

  it('stop() closes the stream, the consumer and the DLQ producer', async () => {
    const { consumer, raw, stream, dlqProducer } = setup({
      messages: [],
      consumer: { dlq: 'dlq.v1' },
    });

    await consumer.start();
    await consumer.stop();

    expect(stream.close).toHaveBeenCalled();
    expect(raw.close).toHaveBeenCalled();
    expect(dlqProducer.close).toHaveBeenCalled();
  });

  it('stop() is safe before start()', async () => {
    const { consumer, raw } = setup({ messages: [] });

    await expect(consumer.stop()).resolves.toBeUndefined();
    expect(raw.close).toHaveBeenCalled();
  });

  it('stop() twice does not throw', async () => {
    const { consumer } = setup({ messages: [] });

    await consumer.start();
    await consumer.stop();
    await expect(consumer.stop()).resolves.toBeUndefined();
  });

  it('stop() waits for handlers already running before disconnecting', async () => {
    const finishedWork: string[] = [];
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      started = resolve;
    });

    const { consumer, raw } = setup({
      messages: [fakeMessage({ partition: 0 }), fakeMessage({ partition: 1 })],
      handler: async event => {
        started();
        await new Promise(resolve => setTimeout(resolve, 20));
        finishedWork.push(`p${event.partition}`);
      },
    });

    await consumer.start();
    await firstStarted;
    await consumer.stop();

    // Work already running completes; the broker connection closes only after.
    expect(finishedWork.length).toBeGreaterThan(0);
    expect(raw.close).toHaveBeenCalled();
  });

  it('abandons queued-but-unstarted messages on stop() — they get redelivered', async () => {
    const messages = Array.from({ length: 6 }, (_, i) =>
      fakeMessage({ partition: 0, offset: BigInt(i) }),
    );
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      started = resolve;
    });

    const { consumer } = setup({
      messages,
      handler: async () => {
        started();
        await new Promise(resolve => setTimeout(resolve, 20));
      },
    });

    await consumer.start();
    await firstStarted;
    await consumer.stop();

    expect(consumer.stats.received).toBeLessThan(messages.length);
  });

  it('registers no process signal handlers', async () => {
    const before = process.listenerCount('SIGTERM');

    const { consumer } = setup({ messages: [] });
    await drain(consumer);

    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('exposes the underlying consumer as an escape hatch', () => {
    const { consumer, raw } = setup({ messages: [] });

    expect(consumer.consumer).toBe(raw as never);
  });
});

describe('stats', () => {
  it('starts at zero', () => {
    const { consumer } = setup({ messages: [] });

    expect(consumer.stats).toEqual({
      received: 0,
      processed: 0,
      retried: 0,
      skipped: 0,
      dlq: 0,
      failed: 0,
    });
  });

  it('counts everything that happened', async () => {
    const messages = [fakeMessage(), fakeMessage(), fakeMessage()];
    let call = 0;
    const { consumer } = setup({
      messages,
      handler: () => {
        // First message succeeds, the other two are poison.
        if (++call > 1) throw new Error('poison');
      },
      consumer: { failurePolicy: 'skip', maxRetries: 1 },
    });

    await drain(consumer);

    expect(consumer.stats).toEqual({
      received: 3,
      processed: 1,
      retried: 2,
      skipped: 2,
      dlq: 0,
      failed: 0,
    });
  });
});
