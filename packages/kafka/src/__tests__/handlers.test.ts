import { describe, it, expect, vi } from 'vitest';
import { asFunction, asValue, createApp, Lifetime } from '@moribashi/core';
import {
  HandlerBindingError,
  isEventHandler,
  resolveHandlerBindings,
  type EventHandler,
  type Logger,
} from '../index.js';

const silentLog: Logger = { warn: () => {}, info: () => {}, error: () => {} };

function appWith(services: Record<string, unknown>) {
  const app = createApp();
  for (const [name, value] of Object.entries(services)) {
    app.container.register({ [name]: asValue(value) });
  }
  return app;
}

function handler(topic: string | string[], handle = vi.fn()): EventHandler {
  return { topic, handle };
}

describe('isEventHandler', () => {
  it('accepts a single-topic handler', () => {
    expect(isEventHandler({ topic: 't', handle() {} })).toBe(true);
  });

  it('accepts a multi-topic handler', () => {
    expect(isEventHandler({ topic: ['a', 'b'], handle() {} })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a function', () => {}],
    ['no handle', { topic: 't' }],
    ['no topic', { handle() {} }],
    ['an empty topic array', { topic: [], handle() {} }],
    ['a non-string topic entry', { topic: ['a', 3], handle() {} }],
    ['a numeric topic', { topic: 3, handle() {} }],
  ])('rejects %s', (_label, value) => {
    expect(isEventHandler(value)).toBe(false);
  });
});

describe('explicit bindings', () => {
  it('resolves a DI name', () => {
    const identityHandler = handler('iam.identity.created.v1');
    const app = appWith({ identityHandler });

    const bindings = resolveHandlerBindings({
      app,
      handlers: { 'iam.identity.created.v1': 'identityHandler' },
      convention: false,
    });

    expect(bindings.get('iam.identity.created.v1')).toMatchObject({
      name: 'identityHandler',
      source: 'explicit',
    });
  });

  it('binds a topic the named handler does not itself declare', async () => {
    const handle = vi.fn();
    const app = appWith({ identityHandler: { topic: 'declared', handle } });

    const bindings = resolveHandlerBindings({
      app,
      handlers: { 'mapped.topic': 'identityHandler' },
      convention: false,
    });

    // The map key is the binding; the handler's own declaration is only used
    // by convention discovery.
    expect([...bindings.keys()]).toEqual(['mapped.topic']);
  });

  it('accepts a bare function', async () => {
    const handle = vi.fn();
    const bindings = resolveHandlerBindings({
      app: createApp(),
      handlers: { t: handle },
      convention: false,
    });

    await bindings.get('t')!.handle({} as never, {} as never);
    expect(handle).toHaveBeenCalled();
  });

  it('accepts an inline handler object and keeps `this` bound', async () => {
    const seen: string[] = [];
    const inline = {
      topic: 't',
      label: 'inline-handler',
      async handle(this: { label: string }) {
        seen.push(this.label);
      },
    };

    const bindings = resolveHandlerBindings({
      app: createApp(),
      handlers: { t: inline },
      convention: false,
    });
    await bindings.get('t')!.handle({} as never, {} as never);

    expect(seen).toEqual(['inline-handler']);
  });

  it('throws when the named service does not exist', () => {
    expect(() =>
      resolveHandlerBindings({
        app: createApp(),
        handlers: { t: 'missingHandler' },
        convention: false,
      }),
    ).toThrow(HandlerBindingError);
  });

  it('names the topic on a missing-service error', () => {
    try {
      resolveHandlerBindings({
        app: createApp(),
        handlers: { 'my.topic': 'missingHandler' },
        convention: false,
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as HandlerBindingError).topic).toBe('my.topic');
    }
  });

  it('throws when the named service is not handler-shaped', () => {
    const app = appWith({ notAHandler: { nope: true } });

    expect(() =>
      resolveHandlerBindings({ app, handlers: { t: 'notAHandler' }, convention: false }),
    ).toThrow(/is not a handler/);
  });

  it('throws when the binding value is nonsense', () => {
    expect(() =>
      resolveHandlerBindings({
        app: createApp(),
        handlers: { t: 42 as never },
        convention: false,
      }),
    ).toThrow(/is not a handler/);
  });
});

describe('convention bindings', () => {
  it('discovers *Handler services and reads their declared topic', () => {
    const app = appWith({
      identityHandler: handler('iam.identity.created.v1'),
      ordersHandler: handler('orders.placed.v1'),
    });

    const bindings = resolveHandlerBindings({ app, log: silentLog });

    expect([...bindings.keys()].sort()).toEqual([
      'iam.identity.created.v1',
      'orders.placed.v1',
    ]);
    expect(bindings.get('orders.placed.v1')!.source).toBe('convention');
  });

  it('binds every topic a multi-topic handler declares', () => {
    const app = appWith({ auditHandler: handler(['a.v1', 'b.v1']) });

    const bindings = resolveHandlerBindings({ app, log: silentLog });

    expect([...bindings.keys()].sort()).toEqual(['a.v1', 'b.v1']);
  });

  it('ignores registrations that do not match the name pattern', () => {
    const app = appWith({
      identityHandler: handler('a'),
      booksService: handler('b'),
    });

    expect([...resolveHandlerBindings({ app, log: silentLog }).keys()]).toEqual(['a']);
  });

  it('ignores *Handler services that are not handler-shaped', () => {
    const app = appWith({
      identityHandler: handler('a'),
      errorHandler: { report() {} },
    });

    expect([...resolveHandlerBindings({ app, log: silentLog }).keys()]).toEqual(['a']);
  });

  it('accepts a narrower pattern', () => {
    const app = appWith({
      identityHandler: handler('a'),
      legacyHandler: handler('b'),
    });

    const bindings = resolveHandlerBindings({
      app,
      convention: /^identityHandler$/,
      log: silentLog,
    });

    expect([...bindings.keys()]).toEqual(['a']);
  });

  it('can be turned off entirely', () => {
    const app = appWith({ identityHandler: handler('a') });

    expect(() =>
      resolveHandlerBindings({ app, handlers: { b: () => {} }, convention: false }),
    ).not.toThrow();
    expect([
      ...resolveHandlerBindings({ app, handlers: { b: () => {} }, convention: false }).keys(),
    ]).toEqual(['b']);
  });

  it('works on classes registered the way app.scan() registers them', async () => {
    class IdentityHandler {
      readonly topic = 'iam.identity.created.v1';
      async handle() {}
    }
    const app = createApp();
    app.container.register({
      identityHandler: asFunction(() => new IdentityHandler()).setLifetime(Lifetime.SINGLETON),
    });

    const bindings = resolveHandlerBindings({ app, log: silentLog });

    expect(bindings.get('iam.identity.created.v1')!.name).toBe('identityHandler');
  });
});

describe('precedence and conflicts', () => {
  it('explicit wins over convention for the same topic', async () => {
    const conventionHandle = vi.fn();
    const explicitHandle = vi.fn();
    const app = appWith({
      identityHandler: handler('t', conventionHandle),
      overrideHandler: { topic: 'other', handle: explicitHandle },
    });

    const bindings = resolveHandlerBindings({
      app,
      handlers: { t: 'overrideHandler' },
      log: silentLog,
    });

    expect(bindings.get('t')!.source).toBe('explicit');
    await bindings.get('t')!.handle({} as never, {} as never);
    expect(explicitHandle).toHaveBeenCalled();
    expect(conventionHandle).not.toHaveBeenCalled();
  });

  it('logs when an explicit binding shadows a convention one', () => {
    const infos: Array<Record<string, unknown>> = [];
    const app = appWith({
      identityHandler: handler('t'),
      otherHandler: { topic: 'unused', handle: vi.fn() },
    });

    resolveHandlerBindings({
      app,
      handlers: { t: 'otherHandler' },
      log: { warn: () => {}, info: obj => void infos.push(obj) },
    });

    expect(infos[0]).toMatchObject({ topic: 't', explicit: 'otherHandler', convention: 'identityHandler' });
  });

  it('a topic bound twice by convention is a startup error', () => {
    const app = appWith({
      aHandler: handler('shared.topic'),
      bHandler: handler('shared.topic'),
    });

    expect(() => resolveHandlerBindings({ app, log: silentLog })).toThrow(HandlerBindingError);
  });

  it('names both handlers in the double-bind error, deterministically', () => {
    const app = appWith({
      zebraHandler: handler('shared.topic'),
      alphaHandler: handler('shared.topic'),
    });

    // Names are sorted, so the message is the same on every run regardless of
    // registration or filesystem order.
    expect(() => resolveHandlerBindings({ app, log: silentLog })).toThrow(
      /"alphaHandler" and "zebraHandler"/,
    );
  });

  it('a double bind via a multi-topic handler is caught too', () => {
    const app = appWith({
      aHandler: handler(['x', 'shared']),
      bHandler: handler(['shared', 'y']),
    });

    expect(() => resolveHandlerBindings({ app, log: silentLog })).toThrow(/shared/);
  });

  it('an explicit binding defuses what would be a convention double bind', () => {
    const app = appWith({
      aHandler: handler('shared'),
      bHandler: handler('shared'),
    });

    const bindings = resolveHandlerBindings({
      app,
      handlers: { shared: 'aHandler' },
      log: silentLog,
    });

    expect(bindings.get('shared')!.name).toBe('aHandler');
  });
});

describe('no handlers at all', () => {
  it('is a startup error', () => {
    expect(() => resolveHandlerBindings({ app: createApp(), log: silentLog })).toThrow(
      HandlerBindingError,
    );
  });

  it('points at both binding styles in the message', () => {
    expect(() => resolveHandlerBindings({ app: createApp(), log: silentLog })).toThrow(
      /handlers.*map.*\*\.handler\.ts/s,
    );
  });
});
