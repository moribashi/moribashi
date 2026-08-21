import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asFunction, createApp, Lifetime } from '@moribashi/core';
import {
  kafkaConsumerPlugin,
  kafkaPlugin,
  EVENT_SCOPE,
  HandlerBindingError,
  KafkaConfigError,
  SchemaRegistrationError,
  type KafkaClient,
  type EventMessage,
  type KafkaConsumer,
  type KafkaProducer,
  type Logger,
  type SchemaRegistryClient,
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
} from './helpers.js';

const PROTO = `syntax = "proto3";
package iam;
message IdentityCreated { string id = 1; }
`;

let app: ReturnType<typeof createApp> | undefined;
let tmpDir: string;

const savedEnv = { ...process.env };
const silentLog: Logger = { warn: () => {}, info: () => {} };

beforeEach(async () => {
  clearKafkaEnv();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kafka-plugin-'));
});

afterEach(async () => {
  await app?.stop();
  app = undefined;
  process.env = { ...savedEnv };
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('kafkaPlugin — DI registration', () => {
  it('registers kafkaClient, schemaRegistry and producer', async () => {
    const client = fakeClient();
    app = createApp();
    app.use(kafkaPlugin({ client }));
    await app.start();

    expect(app.resolve<KafkaClient>('kafkaClient')).toBe(client);
    expect(app.resolve<SchemaRegistryClient>('schemaRegistry')).toBe(client.registry);
    expect(typeof app.resolve<KafkaProducer>('producer').send).toBe('function');
  });

  it('resolves producer as a singleton — the same instance every time', async () => {
    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient() }));
    await app.start();

    expect(app.resolve<KafkaProducer>('producer')).toBe(app.resolve<KafkaProducer>('producer'));
  });

  it('gives the producer the plugin-configured client’s registry', async () => {
    // Asserted through the registry rather than a real send: the point is
    // *which* registry the producer resolves subjects against, and no broker
    // is reachable in a unit test.
    const registry = fakeRegistry({
      encode: vi.fn(async () => {
        throw new Error('sentinel');
      }),
    });
    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient({ ...baseConfig, clientId: 'svc-iam' }, registry) }));
    await app.start();

    await expect(
      app.resolve<KafkaProducer>('producer').send({ topic: 't', value: { id: 'a' } }),
    ).rejects.toThrow(/sentinel/);
    expect(registry.encode).toHaveBeenCalledWith('t', { id: 'a' });
  });

  it('builds a client from config when none is supplied', async () => {
    app = createApp();
    app.use(kafkaPlugin(baseConfig));
    await app.start();

    expect(app.resolve<KafkaClient>('kafkaClient').config.clientId).toBe('test-service');
  });

  it('builds a client from env when nothing is supplied', async () => {
    process.env.KAFKA_CLIENT_ID = 'env-service';
    process.env.KAFKA_BROKERS = 'redpanda:9092';
    process.env.KAFKA_SCHEMA_REGISTRY_URL = 'http://redpanda:8081';

    app = createApp();
    app.use(kafkaPlugin());
    await app.start();

    expect(app.resolve<KafkaClient>('kafkaClient').config.clientId).toBe('env-service');
  });

  it('fails where the plugin is constructed, not on the first send', () => {
    expect(() => kafkaPlugin({ clientId: 'incomplete' })).toThrow(KafkaConfigError);
  });

  it('carries the plugin name for ordering diagnostics', () => {
    expect(kafkaPlugin({ client: fakeClient() }).name).toBe('@moribashi/kafka');
  });
});

describe('kafkaPlugin — schema registration', () => {
  it('does not register schemas unless asked — registration is producer-scoped', async () => {
    const registry = fakeRegistry();
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), PROTO);

    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient({ ...baseConfig, schemasDir: tmpDir }, registry) }));
    await app.start();

    expect(registry.register).not.toHaveBeenCalled();
  });

  it('registers the configured schemasDir when registerSchemas is true', async () => {
    const registry = fakeRegistry();
    await fs.writeFile(path.join(tmpDir, 'iam.identity.created.v1-value.proto'), PROTO);

    app = createApp();
    app.use(
      kafkaPlugin({
        client: fakeClient({ ...baseConfig, schemasDir: tmpDir }, registry),
        registerSchemas: true,
        log: silentLog,
      }),
    );
    await app.start();

    expect(registry.register).toHaveBeenCalledWith(
      'iam.identity.created.v1-value',
      expect.stringContaining('IdentityCreated'),
    );
  });

  it('accepts a directory override', async () => {
    const registry = fakeRegistry();
    const other = path.join(tmpDir, 'proto');
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, 'b-value.proto'), PROTO);

    app = createApp();
    app.use(
      kafkaPlugin({
        client: fakeClient({ ...baseConfig, schemasDir: '/nonexistent' }, registry),
        registerSchemas: other,
        log: silentLog,
      }),
    );
    await app.start();

    expect(registry.register).toHaveBeenCalledOnce();
  });

  it('registers before the app finishes starting', async () => {
    const order: string[] = [];
    const registry = fakeRegistry({
      register: vi.fn(async () => {
        order.push('register-schema');
        return { id: 1 };
      }),
    });
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), PROTO);

    app = createApp();
    app.use(
      kafkaPlugin({
        client: fakeClient({ ...baseConfig, schemasDir: tmpDir }, registry),
        registerSchemas: true,
        log: silentLog,
      }),
    );
    app.use({
      name: 'probe',
      register(a) {
        a.container.register({
          probe: asFunction(() => ({
            onInit: () => void order.push('on-init'),
          })).setLifetime(Lifetime.SINGLETON),
        });
      },
    });

    await app.start();

    // Registration is awaited by start() before any singleton is resolved, so
    // a rejected contract is fatal before the service can serve.
    expect(order).toEqual(['register-schema', 'on-init']);
  });

  it('an incompatible schema fails app.start() — the pod crashloops', async () => {
    const registry = fakeRegistry({
      register: vi.fn(async () => {
        throw new Error('incompatible with an earlier schema');
      }),
    });
    await fs.writeFile(path.join(tmpDir, 'a-value.proto'), PROTO);

    app = createApp();
    app.use(
      kafkaPlugin({
        client: fakeClient({ ...baseConfig, schemasDir: tmpDir }, registry),
        registerSchemas: true,
        log: silentLog,
      }),
    );

    await expect(app.start()).rejects.toBeInstanceOf(SchemaRegistrationError);
    app = undefined; // never started; nothing to stop
  });

  it('a missing schemas directory does not stop the app', async () => {
    const registry = fakeRegistry();

    app = createApp();
    app.use(
      kafkaPlugin({
        client: fakeClient({ ...baseConfig, schemasDir: path.join(tmpDir, 'gone') }, registry),
        registerSchemas: true,
        log: silentLog,
      }),
    );

    await expect(app.start()).resolves.toBeUndefined();
    expect(registry.register).not.toHaveBeenCalled();
    expect(app.resolve<KafkaProducer>('producer')).toBeDefined();
  });
});

describe('kafkaPlugin — lifecycle', () => {
  it('closes the producer on app.stop() via onDestroy', async () => {
    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient() }));
    await app.start();

    const raw = app.resolve<KafkaProducer>('producer').producer;
    const close = vi.spyOn(raw, 'close');

    await app.stop();
    app = undefined;

    expect(close).toHaveBeenCalledOnce();
  });

  it('leaves the underlying producer closed after stop()', async () => {
    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient() }));
    await app.start();

    const raw = app.resolve<KafkaProducer>('producer').producer;
    await app.stop();
    app = undefined;

    expect(raw.closed).toBe(true);
  });

  it('adds no signal handlers of its own', async () => {
    const before = process.listenerCount('SIGTERM');

    app = createApp();
    app.use(kafkaPlugin({ client: fakeClient() }));
    await app.start();

    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});


describe('kafkaConsumerPlugin', () => {
  function consumerDeps(messages = [fakeMessage()]) {
    const registry = fakeRegistry({ decode: vi.fn(async () => ({ ok: true })) });
    const stream = fakeStream(messages);
    const raw = fakeRawConsumer(stream);
    return {
      registry,
      stream,
      raw,
      client: fakeClient(baseConfig, registry),
      seams: {
        consumer: raw as unknown as RawConsumer,
        dlqProducer: fakeRawProducer() as unknown as RawDlqProducer,
        log: silentLog,
        sleep: async () => {},
        onFatal: () => {},
      },
    };
  }

  it('registers consumer as a singleton on the root container', async () => {
    const deps = consumerDeps([]);
    app = createApp();
    app.use(
      kafkaConsumerPlugin({
        client: deps.client,
        groupId: 'g',
        handlers: { t: () => {} },
        convention: false,
        ...deps.seams,
      }),
    );
    await app.start();

    const consumer = app.resolve<KafkaConsumer>('consumer');
    expect(typeof consumer.start).toBe('function');
    expect(app.resolve<KafkaConsumer>('consumer')).toBe(consumer);
  });

  it('joins the group during app.start() via onInit', async () => {
    const deps = consumerDeps([]);
    app = createApp();
    app.use(
      kafkaConsumerPlugin({
        client: deps.client,
        groupId: 'g',
        handlers: { t: () => {} },
        convention: false,
        ...deps.seams,
      }),
    );
    await app.start();

    expect(deps.raw.consume).toHaveBeenCalledOnce();
  });

  it('disconnects during app.stop() via onDestroy', async () => {
    const deps = consumerDeps([]);
    app = createApp();
    app.use(
      kafkaConsumerPlugin({
        client: deps.client,
        groupId: 'g',
        handlers: { t: () => {} },
        convention: false,
        ...deps.seams,
      }),
    );
    await app.start();
    await app.stop();
    app = undefined;

    expect(deps.stream.close).toHaveBeenCalled();
    expect(deps.raw.close).toHaveBeenCalled();
  });

  it('registers kafkaClient and schemaRegistry when used standalone', async () => {
    const deps = consumerDeps([]);
    app = createApp();
    app.use(
      kafkaConsumerPlugin({
        client: deps.client,
        groupId: 'g',
        handlers: { t: () => {} },
        convention: false,
        ...deps.seams,
      }),
    );
    await app.start();

    expect(app.resolve('kafkaClient')).toBe(deps.client);
    expect(app.resolve('schemaRegistry')).toBe(deps.client.registry);
  });

  it('reuses the client kafkaPlugin already registered', async () => {
    const deps = consumerDeps([]);
    app = createApp();
    app.use(kafkaPlugin({ client: deps.client }));
    app.use(
      kafkaConsumerPlugin({
        groupId: 'g',
        handlers: { t: () => {} },
        convention: false,
        ...deps.seams,
      }),
    );
    await app.start();

    // One client, one place for config to be wrong.
    expect(app.resolve('kafkaClient')).toBe(deps.client);
    expect(app.resolve<KafkaProducer>('producer')).toBeDefined();
    expect(app.resolve<KafkaConsumer>('consumer')).toBeDefined();
  });

  it('carries a distinct plugin name from the producer plugin', () => {
    const deps = consumerDeps([]);
    expect(
      kafkaConsumerPlugin({
        client: deps.client,
        groupId: 'g',
        handlers: { t: () => {} },
        ...deps.seams,
      }).name,
    ).toBe('@moribashi/kafka/consumer');
  });

  it('binds handlers scanned after app.use() — binding happens at onInit', async () => {
    const deps = consumerDeps([fakeMessage({ topic: 'late.topic' })]);
    const handle = vi.fn();

    app = createApp();
    app.use(
      kafkaConsumerPlugin({
        client: deps.client,
        groupId: 'g',
        ...deps.seams,
      }),
    );
    // Registered only after the plugin was used, the way app.scan() would.
    app.container.register({
      lateHandler: asFunction(() => ({ topic: 'late.topic', handle })).setLifetime(
        Lifetime.SINGLETON,
      ),
    });

    await app.start();
    await app.resolve<KafkaConsumer>('consumer').finished;

    expect(handle).toHaveBeenCalledOnce();
    expect(app.resolve<KafkaConsumer>('consumer').topics).toEqual(['late.topic']);
  });

  it('a double-bound topic fails app.start()', async () => {
    const deps = consumerDeps([]);
    app = createApp();
    app.use(kafkaConsumerPlugin({ client: deps.client, groupId: 'g', ...deps.seams }));
    for (const name of ['aHandler', 'bHandler']) {
      app.container.register({
        [name]: asFunction(() => ({ topic: 'shared.topic', handle: vi.fn() })).setLifetime(
          Lifetime.SINGLETON,
        ),
      });
    }

    await expect(app.start()).rejects.toBeInstanceOf(HandlerBindingError);
    app = undefined;
  });

  it('no handlers at all fails app.start()', async () => {
    const deps = consumerDeps([]);
    app = createApp();
    app.use(kafkaConsumerPlugin({ client: deps.client, groupId: 'g', ...deps.seams }));

    await expect(app.start()).rejects.toBeInstanceOf(HandlerBindingError);
    app = undefined;
  });

  it('validates groupId where the plugin is constructed', () => {
    expect(() => kafkaConsumerPlugin({ groupId: '   ' })).toThrow(/no default/);
  });

  it('fails at app.use() on bad broker config, not on the first poll', () => {
    // Broker config can only be validated once we know whether kafkaPlugin
    // already registered a client — which needs the app.
    const badApp = createApp();
    expect(() =>
      badApp.use(kafkaConsumerPlugin({ groupId: 'g', clientId: 'incomplete' })),
    ).toThrow(KafkaConfigError);
  });

  it('runs handlers with services from the event scope', async () => {
    class Audit {
      readonly event: EventMessage;
      constructor({ event }: { event: EventMessage }) {
        this.event = event;
      }
    }
    const seen: string[] = [];
    const deps = consumerDeps([fakeMessage({ topic: 't', offset: 5n })]);

    app = createApp();
    app.registerInScope(EVENT_SCOPE, { audit: Audit });
    app.use(
      kafkaConsumerPlugin({
        client: deps.client,
        groupId: 'g',
        convention: false,
        handlers: {
          t: (_event, scope) => {
            seen.push(String(scope.resolve<Audit>('audit').event.offset));
          },
        },
        ...deps.seams,
      }),
    );
    await app.start();
    await app.resolve<KafkaConsumer>('consumer').finished;

    expect(seen).toEqual(['5']);
  });

  it('adds no signal handlers of its own', async () => {
    const before = process.listenerCount('SIGTERM');
    const deps = consumerDeps([]);

    app = createApp();
    app.use(
      kafkaConsumerPlugin({
        client: deps.client,
        groupId: 'g',
        handlers: { t: () => {} },
        convention: false,
        ...deps.seams,
      }),
    );
    await app.start();

    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});
