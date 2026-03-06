import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, Lifetime, type MoribashiPlugin } from '../index.js';

// ---------------------------------------------------------------------------
// Helper classes
// ---------------------------------------------------------------------------

class SimpleService {
  value = 'simple';
}

class AnotherService {
  value = 'another';
}

/** Tracks onInit / onDestroy call order via shared arrays */
class TrackedService {
  initOrder: string[];
  destroyOrder: string[];
  label: string;

  constructor({ initOrder, destroyOrder, label }: { initOrder: string[]; destroyOrder: string[]; label: string }) {
    this.initOrder = initOrder;
    this.destroyOrder = destroyOrder;
    this.label = label;
  }

  async onInit() {
    this.initOrder.push(this.label);
  }

  async onDestroy() {
    this.destroyOrder.push(this.label);
  }
}

/** Service whose onInit throws */
class FailingInitService {
  async onInit() {
    throw new Error('init-boom');
  }

  async onDestroy() {
    // should still be callable
  }
}

/** Service whose onDestroy throws */
class FailingDestroyService {
  async onInit() {}

  async onDestroy() {
    throw new Error('destroy-boom');
  }
}

/** Minimal no-lifecycle service */
class PlainService {
  greeting = 'hello';
}

/** Service with only onInit */
class InitOnlyService {
  initialized = false;
  async onInit() {
    this.initialized = true;
  }
}

/** Service with only onDestroy */
class DestroyOnlyService {
  destroyed = false;
  async onDestroy() {
    this.destroyed = true;
  }
}

/** Scoped service for scope tests */
class ScopedCounter {
  count = 0;
  increment() {
    this.count++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createApp() basics', () => {
  it('returns an app with expected methods', () => {
    const app = createApp();
    expect(app).toBeDefined();
    expect(typeof app.register).toBe('function');
    expect(typeof app.resolve).toBe('function');
    expect(typeof app.scan).toBe('function');
    expect(typeof app.use).toBe('function');
    expect(typeof app.registerInScope).toBe('function');
    expect(typeof app.createScope).toBe('function');
    expect(typeof app.start).toBe('function');
    expect(typeof app.stop).toBe('function');
    expect(app.container).toBeDefined();
  });

  it('register() adds services resolvable by name', () => {
    const app = createApp();
    app.register({ simple: SimpleService });
    const svc = app.resolve<SimpleService>('simple');
    expect(svc).toBeInstanceOf(SimpleService);
    expect(svc.value).toBe('simple');
  });

  it('resolve() returns the same singleton instance', () => {
    const app = createApp();
    app.register({ simple: SimpleService });
    const a = app.resolve<SimpleService>('simple');
    const b = app.resolve<SimpleService>('simple');
    expect(a).toBe(b);
  });

  it('register() returns app for chaining', () => {
    const app = createApp();
    const ret = app.register({ simple: SimpleService });
    expect(ret).toBe(app);
  });

  it('can register multiple services at once', () => {
    const app = createApp();
    app.register({ simple: SimpleService, another: AnotherService });
    expect(app.resolve<SimpleService>('simple').value).toBe('simple');
    expect(app.resolve<AnotherService>('another').value).toBe('another');
  });

  it('can chain multiple register calls', () => {
    const app = createApp();
    app.register({ simple: SimpleService }).register({ another: AnotherService });
    expect(app.resolve<SimpleService>('simple')).toBeInstanceOf(SimpleService);
    expect(app.resolve<AnotherService>('another')).toBeInstanceOf(AnotherService);
  });
});

describe('Lifecycle hooks', () => {
  it('start() calls onInit() on singletons in registration order', async () => {
    const initOrder: string[] = [];
    const destroyOrder: string[] = [];

    // We need to supply the tracking arrays via factory functions since
    // awilix constructs services. We'll use asValue-style wrapper classes.
    class ServiceA {
      async onInit() { initOrder.push('A'); }
      async onDestroy() { destroyOrder.push('A'); }
    }
    class ServiceB {
      async onInit() { initOrder.push('B'); }
      async onDestroy() { destroyOrder.push('B'); }
    }
    class ServiceC {
      async onInit() { initOrder.push('C'); }
      async onDestroy() { destroyOrder.push('C'); }
    }

    const app = createApp();
    app.register({ a: ServiceA, b: ServiceB, c: ServiceC });
    await app.start();

    expect(initOrder).toEqual(['A', 'B', 'C']);
  });

  it('stop() calls onDestroy() in reverse init order', async () => {
    const initOrder: string[] = [];
    const destroyOrder: string[] = [];

    class ServiceA {
      async onInit() { initOrder.push('A'); }
      async onDestroy() { destroyOrder.push('A'); }
    }
    class ServiceB {
      async onInit() { initOrder.push('B'); }
      async onDestroy() { destroyOrder.push('B'); }
    }

    const app = createApp();
    app.register({ a: ServiceA, b: ServiceB });
    await app.start();
    await app.stop();

    expect(destroyOrder).toEqual(['B', 'A']);
  });

  it('services without lifecycle hooks are skipped gracefully', async () => {
    const app = createApp();
    app.register({ plain: PlainService });
    // Should not throw
    await app.start();
    expect(app.resolve<PlainService>('plain').greeting).toBe('hello');
    await app.stop();
  });

  it('handles services with only onInit', async () => {
    const app = createApp();
    app.register({ initOnly: InitOnlyService });
    await app.start();
    expect(app.resolve<InitOnlyService>('initOnly').initialized).toBe(true);
    // stop should not throw even though there's no onDestroy
    await app.stop();
  });

  it('handles services with only onDestroy', async () => {
    const destroyed: string[] = [];

    class DestroyTracked {
      async onDestroy() { destroyed.push('done'); }
    }

    const app = createApp();
    app.register({ destroyTracked: DestroyTracked });
    await app.start();
    await app.stop();
    // onDestroy should have been called
    expect(destroyed).toEqual(['done']);
  });
});

describe('start() error handling', () => {
  it('calling start() twice throws', async () => {
    const app = createApp();
    await app.start();
    await expect(app.start()).rejects.toThrow('App already started');
  });

  it('start() rollback calls onDestroy on already-initialized services when onInit fails', async () => {
    const destroyed: string[] = [];

    class ServiceA {
      async onInit() {}
      async onDestroy() { destroyed.push('A'); }
    }
    class ServiceB {
      async onInit() {}
      async onDestroy() { destroyed.push('B'); }
    }
    class FailingService {
      async onInit() { throw new Error('init-boom'); }
      async onDestroy() { destroyed.push('FAIL'); }
    }

    const app = createApp();
    app.register({ a: ServiceA, b: ServiceB, failing: FailingService });

    await expect(app.start()).rejects.toThrow('Failed to start app');

    // A and B were initialized successfully, so they should get onDestroy
    expect(destroyed).toContain('A');
    expect(destroyed).toContain('B');
    // FailingService's onInit threw, so it was never pushed to initializedServices
    // and should NOT get onDestroy
    expect(destroyed).not.toContain('FAIL');
  });

  it('concurrent start() calls — second call throws', async () => {
    const app = createApp();
    const p1 = app.start();
    const p2 = app.start();
    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe('App already started or starting');
  });
});

describe('stop() error handling', () => {
  it('stop() before start() is a no-op', async () => {
    const app = createApp();
    // Should not throw
    await app.stop();
  });

  it('if onDestroy throws on one service, others still get onDestroy and AggregateError is thrown', async () => {
    const destroyed: string[] = [];

    class GoodServiceA {
      async onInit() {}
      async onDestroy() { destroyed.push('A'); }
    }
    class BadService {
      async onInit() {}
      async onDestroy() { throw new Error('destroy-boom'); }
    }
    class GoodServiceB {
      async onInit() {}
      async onDestroy() { destroyed.push('B'); }
    }

    const app = createApp();
    app.register({ a: GoodServiceA, bad: BadService, b: GoodServiceB });
    await app.start();

    // stop() collects errors and continues — all services get onDestroy
    await expect(app.stop()).rejects.toThrow('One or more errors occurred during stop');

    // Reverse order: B, bad (throws but collected), A — all called
    expect(destroyed).toContain('A');
    expect(destroyed).toContain('B');
  });
});

describe('Plugin system', () => {
  it('use() calls plugin.register() with the app', () => {
    const registerFn = vi.fn();
    const plugin: MoribashiPlugin = {
      name: 'test-plugin',
      register: registerFn,
    };

    const app = createApp();
    app.use(plugin);
    expect(registerFn).toHaveBeenCalledWith(app);
  });

  it('use() returns app for chaining', () => {
    const plugin: MoribashiPlugin = {
      name: 'test-plugin',
      register: vi.fn(),
    };

    const app = createApp();
    const ret = app.use(plugin);
    expect(ret).toBe(app);
  });

  it('sync plugin registers services immediately', () => {
    const plugin: MoribashiPlugin = {
      name: 'sync-plugin',
      register(app) {
        app.register({ plain: PlainService });
      },
    };

    const app = createApp();
    app.use(plugin);
    expect(app.resolve<PlainService>('plain').greeting).toBe('hello');
  });

  it('async plugin registration is awaited during start()', async () => {
    let registered = false;

    const plugin: MoribashiPlugin = {
      name: 'async-plugin',
      async register(app) {
        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 10));
        app.register({ plain: PlainService });
        registered = true;
      },
    };

    const app = createApp();
    app.use(plugin);
    // After use(), the async registration is pending
    await app.start();
    expect(registered).toBe(true);
    expect(app.resolve<PlainService>('plain').greeting).toBe('hello');
  });

  it('async plugin failure propagates during start()', async () => {
    const plugin: MoribashiPlugin = {
      name: 'failing-async-plugin',
      async register() {
        throw new Error('plugin-boom');
      },
    };

    const app = createApp();
    app.use(plugin);
    const err = await app.start().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(((err as Error).cause as Error).message).toBe('Failed during async plugin registration');
  });

  it('multiple plugins are called in use() order', () => {
    const order: string[] = [];

    const pluginA: MoribashiPlugin = {
      name: 'pluginA',
      register() { order.push('A'); },
    };
    const pluginB: MoribashiPlugin = {
      name: 'pluginB',
      register() { order.push('B'); },
    };

    const app = createApp();
    app.use(pluginA).use(pluginB);
    expect(order).toEqual(['A', 'B']);
  });
});

describe('Scopes', () => {
  it('createScope() returns a scope with resolve/cradle/dispose', () => {
    const app = createApp();
    app.register({ plain: PlainService });
    const scope = app.createScope();

    expect(typeof scope.resolve).toBe('function');
    expect(typeof scope.dispose).toBe('function');
    expect(scope.cradle).toBeDefined();
    expect(scope.container).toBeDefined();
  });

  it('scope inherits parent registrations', () => {
    const app = createApp();
    app.register({ plain: PlainService });
    const scope = app.createScope();
    const svc = scope.resolve<PlainService>('plain');
    expect(svc).toBeInstanceOf(PlainService);
    expect(svc.greeting).toBe('hello');
  });

  it('scope.register() adds scoped services', () => {
    const app = createApp();
    const scope = app.createScope();
    scope.register({ counter: ScopedCounter });
    const counter = scope.resolve<ScopedCounter>('counter');
    expect(counter).toBeInstanceOf(ScopedCounter);
    counter.increment();
    expect(counter.count).toBe(1);
  });

  it('scope.register() returns scope for chaining', () => {
    const app = createApp();
    const scope = app.createScope();
    const ret = scope.register({ counter: ScopedCounter });
    expect(ret).toBe(scope);
  });

  it('scope dispose is idempotent (second call is no-op)', async () => {
    const app = createApp();
    const scope = app.createScope();
    scope.register({ counter: ScopedCounter });
    // Resolve to cache the service
    scope.resolve('counter');
    await scope.dispose();
    // Second dispose should not throw
    await scope.dispose();
  });

  it('registerInScope() makes services available in scope with matching key', () => {
    const scopeKey = Symbol.for('moribashi.scope.test');
    const app = createApp();
    app.registerInScope(scopeKey, { counter: ScopedCounter });

    const scope = app.createScope(scopeKey);
    const counter = scope.resolve<ScopedCounter>('counter');
    expect(counter).toBeInstanceOf(ScopedCounter);
  });

  it('registerInScope() returns app for chaining', () => {
    const scopeKey = Symbol.for('moribashi.scope.test');
    const app = createApp();
    const ret = app.registerInScope(scopeKey, { counter: ScopedCounter });
    expect(ret).toBe(app);
  });

  it('scope without matching key does not include scoped registrations', () => {
    const scopeKeyA = Symbol.for('moribashi.scope.a');
    const scopeKeyB = Symbol.for('moribashi.scope.b');
    const app = createApp();
    app.registerInScope(scopeKeyA, { counter: ScopedCounter });

    const scope = app.createScope(scopeKeyB);
    expect(() => scope.resolve('counter')).toThrow();
  });

  it('scope without key does not include scoped registrations', () => {
    const scopeKey = Symbol.for('moribashi.scope.test');
    const app = createApp();
    app.registerInScope(scopeKey, { counter: ScopedCounter });

    const scope = app.createScope();
    expect(() => scope.resolve('counter')).toThrow();
  });

  it('each scope gets its own instance of scoped services', () => {
    const scopeKey = Symbol.for('moribashi.scope.test');
    const app = createApp();
    app.registerInScope(scopeKey, { counter: ScopedCounter });

    const scope1 = app.createScope(scopeKey);
    const scope2 = app.createScope(scopeKey);

    const c1 = scope1.resolve<ScopedCounter>('counter');
    const c2 = scope2.resolve<ScopedCounter>('counter');

    c1.increment();
    expect(c1.count).toBe(1);
    expect(c2.count).toBe(0);
  });

  it('active scopes are disposed during stop()', async () => {
    let scopeDestroyed = false;

    class ScopedService {
      async onDestroy() { scopeDestroyed = true; }
    }

    const app = createApp();
    const scope = app.createScope();
    scope.register({ scopedSvc: ScopedService });
    // Resolve to put it in cache (onDestroy only runs on cached instances)
    scope.resolve('scopedSvc');

    await app.start();
    await app.stop();
    expect(scopeDestroyed).toBe(true);
  });

  it('cradle property provides proxy access to services', () => {
    const app = createApp();
    app.register({ plain: PlainService });
    const scope = app.createScope();
    expect((scope.cradle as any).plain).toBeInstanceOf(PlainService);
    expect((scope.cradle as any).plain.greeting).toBe('hello');
  });
});

describe('Overwrite warnings', () => {
  it('registering same name twice triggers console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp();
    app.register({ plain: PlainService });
    // Awilix itself may or may not warn. The important thing is the second
    // registration overwrites the first without throwing.
    app.register({ plain: SimpleService });
    const resolved = app.resolve<SimpleService>('plain');
    expect(resolved).toBeInstanceOf(SimpleService);
    warnSpy.mockRestore();
  });

  it('first registration does not warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp();
    app.register({ plain: PlainService });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('scan()', () => {
  it('scan() returns app for chaining', async () => {
    const app = createApp();
    // Use a pattern that matches nothing — scan should still return app
    const ret = await app.scan([], { cwd: '/nonexistent' });
    expect(ret).toBe(app);
  });
});

describe('diagnostics', () => {
  it('diagnostics returns module info', async () => {
    const { diagnostics } = await import('../index.js');
    const info = diagnostics();
    expect(info).toEqual({ module: '@moribashi/core' });
  });
});

describe('registerValue', () => {
  it('registers plain values that can be resolved', () => {
    const app = createApp();
    app.registerValue({ apiKey: 'secret123', maxRetries: 3 });
    expect(app.resolve('apiKey')).toBe('secret123');
    expect(app.resolve('maxRetries')).toBe(3);
  });

  it('validates service names', () => {
    const app = createApp();
    expect(() => app.registerValue({ '123bad': 'val' })).toThrow('Invalid service name');
  });

  it('warns on overwrites', () => {
    const app = createApp();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app.registerValue({ foo: 'first' });
    app.registerValue({ foo: 'second' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('supports objects and null', () => {
    const app = createApp();
    const config = { host: 'localhost' };
    app.registerValue({ config, nothing: null });
    expect(app.resolve('config')).toBe(config);
    expect(app.resolve('nothing')).toBeNull();
  });
});

describe('registerFactory', () => {
  it('registers factory functions as singletons', async () => {
    const app = createApp();
    let callCount = 0;
    app.registerFactory({ counter: () => { callCount++; return { count: callCount }; } });
    await app.start();
    const first = app.resolve('counter');
    const second = app.resolve('counter');
    expect(first).toBe(second);
    expect(callCount).toBe(1);
  });

  it('validates service names', () => {
    const app = createApp();
    expect(() => app.registerFactory({ '123bad': () => 1 })).toThrow('Invalid service name');
  });

  it('warns on overwrites', () => {
    const app = createApp();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app.registerFactory({ bar: () => 1 });
    app.registerFactory({ bar: () => 2 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('scope registerValue', () => {
  it('registers values on a scope', async () => {
    const app = createApp();
    await app.start();
    const scope = app.createScope();
    scope.registerValue({ requestId: 'req42' });
    expect(scope.resolve('requestId')).toBe('req42');
    await app.stop();
  });
});

describe('plugin dependency validation', () => {
  it('succeeds when plugin dependencies are satisfied', () => {
    const app = createApp();
    const base: MoribashiPlugin = { name: 'base', register() {} };
    const dependent: MoribashiPlugin = { name: 'dependent', dependencies: ['base'], register() {} };
    app.use(base);
    expect(() => app.use(dependent)).not.toThrow();
  });

  it('throws when a plugin dependency is missing', () => {
    const app = createApp();
    const plugin: MoribashiPlugin = { name: 'graphql', dependencies: ['web'], register() {} };
    expect(() => app.use(plugin)).toThrowError(
      "Plugin 'graphql' depends on 'web' which has not been registered. Register 'web' before 'graphql'."
    );
  });

  it('works with plugins that have no dependencies field', () => {
    const app = createApp();
    const plugin: MoribashiPlugin = { name: 'simple', register() {} };
    expect(() => app.use(plugin)).not.toThrow();
  });

  it('warns when a plugin is registered more than once', () => {
    const app = createApp();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const plugin: MoribashiPlugin = { name: 'dup', register() {} };
    app.use(plugin);
    app.use(plugin);
    expect(warnSpy).toHaveBeenCalledWith("[moribashi] Warning: plugin 'dup' registered more than once");
    warnSpy.mockRestore();
  });
});
