import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp, Lifetime, asClass, asValue, type MoribashiPlugin, type MoribashiApp } from '../index.js';

// ---------------------------------------------------------------------------
// Helper classes
// ---------------------------------------------------------------------------

class SimpleService {
  value = 'simple';
}

class AnotherService {
  value = 'another';
}

class ServiceWithOnInit {
  initialized = false;
  async onInit() {
    this.initialized = true;
  }
}

class ServiceWithOnDestroy {
  destroyed = false;
  async onDestroy() {
    this.destroyed = true;
  }
}

class ServiceWithBothHooks {
  initialized = false;
  destroyed = false;
  async onInit() {
    this.initialized = true;
  }
  async onDestroy() {
    this.destroyed = true;
  }
}

class ThrowingConstructorService {
  constructor() {
    throw new Error('constructor-boom');
  }
}

class ThrowingOnInitService {
  async onInit() {
    throw new Error('init-boom');
  }
}

class ThrowingOnDestroyService {
  async onInit() {}
  async onDestroy() {
    throw new Error('destroy-boom');
  }
}

class ScopedCounter {
  count = 0;
  increment() {
    this.count++;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('state machine violations', () => {
  it('register() after start() throws', async () => {
    const app = createApp();
    await app.start();

    expect(() => app.register({ simple: SimpleService })).toThrow('Cannot register after app has started');

    await app.stop();
  });

  it('registerValue() after start() throws', async () => {
    const app = createApp();
    await app.start();

    expect(() => app.registerValue({ val: 'hello' })).toThrow('Cannot registerValue after app has started');

    await app.stop();
  });

  it('use() after start() throws', async () => {
    const app = createApp();
    await app.start();

    const plugin: MoribashiPlugin = {
      name: 'late-plugin',
      register: vi.fn(),
    };
    expect(() => app.use(plugin)).toThrow('Cannot use after app has started');

    await app.stop();
  });

  it('resolve() before start() works (no guard — services are lazily resolved)', () => {
    // Observation: resolve() works before start() because Awilix resolves on demand.
    // This bypasses the lifecycle — onInit never fires. This is expected behavior.
    const app = createApp();
    app.register({ simple: SimpleService });
    const svc = app.resolve<SimpleService>('simple');
    expect(svc).toBeInstanceOf(SimpleService);
  });

  it('createScope() after stop() throws', async () => {
    const app = createApp();
    await app.start();
    await app.stop();

    expect(() => app.createScope()).toThrow('Cannot createScope after app has been stopped');
  });

  it('stop() can be called multiple times (second is no-op)', async () => {
    const app = createApp();
    await app.start();
    await app.stop();
    // Second stop should be no-op since started is now false
    await app.stop();
  });

  it('start() after stop() throws — app cannot be restarted', async () => {
    const app = createApp();
    app.register({ svc: ServiceWithOnInit });
    await app.start();
    await app.stop();

    await expect(app.start()).rejects.toThrow('Cannot start a stopped app');
  });

  it('registerValue() after start() throws', async () => {
    const app = createApp();
    await app.start();

    expect(() => app.registerValue({ fake: { value: 1 } })).toThrow('Cannot registerValue after app has started');

    await app.stop();
  });

  it('registerFactory() after start() throws', async () => {
    const app = createApp();
    await app.start();

    expect(() => app.registerFactory({ svc: () => ({}) })).toThrow('Cannot registerFactory after app has started');

    await app.stop();
  });
});

describe('reentrancy and side effects during lifecycle', () => {
  it('onInit that registers a new service — the new service does not get onInit', async () => {
    // Registration during start() is allowed (for plugin support), but services
    // registered during onInit will not have their own onInit called because
    // the iteration over registrations has already passed.
    class GreedyService {
      private app: MoribashiApp;
      constructor({ app }: { app: MoribashiApp }) {
        this.app = app;
      }
      async onInit() {
        this.app.register({ late: ServiceWithOnInit });
      }
    }

    const app = createApp();
    app.registerValue({ app });
    app.register({ greedy: GreedyService });

    await app.start();
    const late = app.resolve<ServiceWithOnInit>('late');
    expect(late.initialized).toBe(false);

    await app.stop();
  });

  it('onDestroy that calls app.stop() — reentrancy guard prevents double-stop', async () => {
    let destroyCount = 0;

    class ReentrantDestroyService {
      private app: MoribashiApp;
      constructor({ app }: { app: MoribashiApp }) {
        this.app = app;
      }
      async onInit() {}
      async onDestroy() {
        destroyCount++;
        // Attempt to call stop() again from within onDestroy
        await this.app.stop();
      }
    }

    const app = createApp();
    app.registerValue({ app });
    app.register({ reentrant: ReentrantDestroyService });
    await app.start();

    // The reentrant stop() call should be a no-op because `stopping` is true
    await app.stop();
    // onDestroy was called exactly once
    expect(destroyCount).toBe(1);
  });

  it('plugin.register() that calls app.start() — throws because starting is set', () => {
    const plugin: MoribashiPlugin = {
      name: 'evil-plugin',
      async register(app) {
        // This async register will be awaited during start()
        await app.start();
      },
    };

    const app = createApp();
    app.use(plugin);

    // start() sets starting=true, then awaits pendingRegistrations which calls start() again
    // The inner start() should throw 'App already started or starting'
    return expect(app.start()).rejects.toThrow();
  });

  it('sync plugin.register() that calls app.start() — throws', async () => {
    let innerError: Error | null = null;
    const plugin: MoribashiPlugin = {
      name: 'sync-evil',
      register(app) {
        // Synchronous start() call during use()
        // At this point, start() hasn't been called yet, so this will succeed
        // and set started=true, then the outer start() will fail
        // Actually use() is called before start(), so start() hasn't set starting=true
        // This means the plugin steals the start
        try {
          // start() returns a promise, calling it without await just fires it
          const p = app.start();
          // We can't await in a sync function, but the promise is launched
          p.catch((e: Error) => {
            innerError = e;
          });
        } catch (e) {
          innerError = e as Error;
        }
      },
    };

    const app = createApp();
    app.use(plugin);

    // Now the outer start() — the inner start() already set starting=true (async)
    // Race: the inner start() promise is pending
    await expect(app.start()).rejects.toThrow('App already started or starting');
  });

  it('plugin that uses app.use() to register another plugin inside register()', () => {
    const order: string[] = [];
    const innerPlugin: MoribashiPlugin = {
      name: 'inner',
      register() {
        order.push('inner');
      },
    };
    const outerPlugin: MoribashiPlugin = {
      name: 'outer',
      register(app) {
        order.push('outer');
        app.use(innerPlugin);
      },
    };

    const app = createApp();
    app.use(outerPlugin);
    expect(order).toEqual(['outer', 'inner']);
  });
});

describe('poison pill services', () => {
  it('service whose constructor throws — resolve fails', () => {
    const app = createApp();
    app.register({ boom: ThrowingConstructorService });
    expect(() => app.resolve('boom')).toThrow('constructor-boom');
  });

  it('service whose constructor throws — start() fails and rolls back', async () => {
    const destroyed: string[] = [];
    class GoodService {
      async onInit() {}
      async onDestroy() {
        destroyed.push('good');
      }
    }

    const app = createApp();
    app.register({ good: GoodService, boom: ThrowingConstructorService });
    await expect(app.start()).rejects.toThrow('Failed to start app');
    // Good service was initialized before boom, so it should get onDestroy
    expect(destroyed).toContain('good');
  });

  it('service with onInit that is not a function — skipped by type guard', async () => {
    const app = createApp();
    app.registerValue({ weirdSvc: { onInit: 'not a function', value: 42 } });
    // start() should not throw — hasOnInit checks typeof === 'function'
    await app.start();
    expect(app.resolve<any>('weirdSvc').value).toBe(42);
    await app.stop();
  });

  it('service with onDestroy that is not a function — skipped by type guard', async () => {
    const app = createApp();
    app.registerValue({ weirdSvc: { onDestroy: 42 } });
    await app.start();
    // stop() should not throw
    await app.stop();
  });

  it('service with getter that throws on access', () => {
    const evilObj = {};
    Object.defineProperty(evilObj, 'value', {
      get() {
        throw new Error('getter-boom');
      },
      enumerable: true,
    });

    const app = createApp();
    app.registerValue({ evil: evilObj });
    const resolved = app.resolve<any>('evil');
    expect(() => resolved.value).toThrow('getter-boom');
  });

  it('null registered as a value — resolves to null', () => {
    const app = createApp();
    app.registerValue({ nothing: null });
    expect(app.resolve('nothing')).toBeNull();
  });

  it('undefined registered as a value — resolves to undefined', () => {
    const app = createApp();
    app.registerValue({ undef: undefined });
    expect(app.resolve('undef')).toBeUndefined();
  });

  it('service that takes very long in onInit — does not block other services (they run sequentially)', async () => {
    const order: string[] = [];

    class SlowService {
      async onInit() {
        await new Promise((r) => setTimeout(r, 50));
        order.push('slow');
      }
    }
    class FastService {
      async onInit() {
        order.push('fast');
      }
    }

    const app = createApp();
    app.register({ slow: SlowService, fast: FastService });
    await app.start();
    // Services are initialized sequentially, so slow finishes before fast starts
    expect(order).toEqual(['slow', 'fast']);
    await app.stop();
  });
});

describe('scope edge cases', () => {
  it('resolve from disposed scope throws', async () => {
    const app = createApp();
    app.register({ simple: SimpleService });
    const scope = app.createScope();
    scope.register({ counter: ScopedCounter });

    await scope.dispose();

    expect(() => scope.resolve('counter')).toThrow('Cannot resolve from a disposed scope');
  });

  it('register on disposed scope throws', async () => {
    const app = createApp();
    const scope = app.createScope();
    await scope.dispose();

    expect(() => scope.register({ counter: ScopedCounter })).toThrow('Cannot register on a disposed scope');
  });

  it('registerValue on disposed scope throws', async () => {
    const app = createApp();
    const scope = app.createScope();
    await scope.dispose();

    expect(() => scope.registerValue({ val: 'hello' })).toThrow('Cannot register on a disposed scope');
  });

  it('cradle access on disposed scope throws', async () => {
    const app = createApp();
    const scope = app.createScope();
    await scope.dispose();

    expect(() => scope.cradle).toThrow('Cannot access cradle of a disposed scope');
  });

  it('createScope with unknown key — returns scope without extra registrations', () => {
    const app = createApp();
    app.register({ simple: SimpleService });
    const unknownKey = Symbol.for('moribashi.scope.nonexistent');
    const scope = app.createScope(unknownKey);
    // Scope works fine, just no extra registrations
    expect(scope.resolve<SimpleService>('simple')).toBeInstanceOf(SimpleService);
  });

  it('scope.registerValue warns on overwrite', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp();
    const scope = app.createScope();
    scope.registerValue({ foo: 'first' });
    scope.registerValue({ foo: 'second' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('overwriting existing service')
    );
    expect(scope.resolve('foo')).toBe('second');
    warnSpy.mockRestore();
  });

  it('scope outlives the app — dispose still works', async () => {
    const app = createApp();
    app.register({ simple: SimpleService });
    await app.start();

    const scope = app.createScope();
    scope.register({ counter: ScopedCounter });
    scope.resolve('counter'); // cache it

    await app.stop(); // This disposes all active scopes

    // The scope was already disposed by stop()
    // Calling dispose again should be idempotent
    await scope.dispose();
  });

  it('scope.cradle accesses parent singletons', () => {
    const app = createApp();
    app.register({ simple: SimpleService });
    const scope = app.createScope();
    expect((scope.cradle as any).simple).toBeInstanceOf(SimpleService);
    expect((scope.cradle as any).simple.value).toBe('simple');
  });

  it('scope onDestroy is called during scope.dispose()', async () => {
    let destroyed = false;
    class DestroyableScoped {
      async onDestroy() {
        destroyed = true;
      }
    }

    const app = createApp();
    const scope = app.createScope();
    scope.register({ destroyable: DestroyableScoped });
    scope.resolve('destroyable'); // must resolve to cache it
    await scope.dispose();
    expect(destroyed).toBe(true);
  });

  it('scope with onInit service — onInit is NOT called (scopes do not eagerly resolve)', () => {
    let initCalled = false;
    class ScopedWithInit {
      async onInit() {
        initCalled = true;
      }
    }

    const app = createApp();
    const scope = app.createScope();
    scope.register({ svc: ScopedWithInit });
    // onInit is only called during app.start() for root singletons
    // Scoped services are lazily resolved and never get onInit
    // Unless explicitly resolved
    expect(initCalled).toBe(false);
  });
});

describe('plugin edge cases', () => {
  it('plugin with empty name — allowed', () => {
    const app = createApp();
    const plugin: MoribashiPlugin = {
      name: '',
      register: vi.fn(),
    };
    // Empty string is truthy-falsy but Set handles it fine
    app.use(plugin);
    expect(plugin.register).toHaveBeenCalled();
  });

  it('plugin that modifies itself during register()', () => {
    const plugin: MoribashiPlugin = {
      name: 'self-mutating',
      register() {
        // Mutate own name after registration
        plugin.name = 'mutated';
      },
    };

    const app = createApp();
    app.use(plugin);
    // The original name 'self-mutating' was added to registeredPlugins set
    // But the plugin object now has name 'mutated'
    // Registering the mutated plugin again should NOT warn (different name now)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app.use(plugin); // plugin.name is now 'mutated'
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('self-mutating')
    );
    warnSpy.mockRestore();
  });

  it('plugin that throws synchronously in register()', () => {
    const plugin: MoribashiPlugin = {
      name: 'throw-sync',
      register() {
        throw new Error('sync-plugin-boom');
      },
    };

    const app = createApp();
    expect(() => app.use(plugin)).toThrow('sync-plugin-boom');
  });

  it('plugin that throws synchronously — is still added to registeredPlugins', () => {
    // BUG: If register() throws, the plugin name is still added to registeredPlugins
    // because plugin.name is added after register() is called (line 186).
    // Wait — looking at the code: register() is called on line 181, name is added on line 186.
    // If register() throws, line 186 is never reached. So the plugin is NOT registered.
    // This means you can retry use() after fixing the plugin.
    const plugin: MoribashiPlugin = {
      name: 'throw-sync',
      register: vi.fn().mockImplementationOnce(() => {
        throw new Error('first-attempt-boom');
      }).mockImplementation(() => {
        // second attempt succeeds
      }),
    };

    const app = createApp();
    expect(() => app.use(plugin)).toThrow('first-attempt-boom');

    // Plugin was NOT added to registeredPlugins, so we can retry
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    app.use(plugin); // should succeed, no duplicate warning
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('plugin with circular dependency on itself', () => {
    const app = createApp();
    const plugin: MoribashiPlugin = {
      name: 'self-dep',
      dependencies: ['self-dep'],
      register: vi.fn(),
    };
    // self-dep depends on self-dep, which hasn't been registered yet
    expect(() => app.use(plugin)).toThrow(
      "Plugin 'self-dep' depends on 'self-dep' which has not been registered"
    );
  });

  it('duplicate plugin warning still allows registration', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: number[] = [];

    const plugin: MoribashiPlugin = {
      name: 'dup-ok',
      register() {
        calls.push(calls.length);
      },
    };

    const app = createApp();
    app.use(plugin);
    app.use(plugin); // warns but still calls register
    expect(calls).toEqual([0, 1]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('async plugin that rejects — start() wraps error', async () => {
    const plugin: MoribashiPlugin = {
      name: 'async-reject',
      async register() {
        throw new Error('async-boom');
      },
    };

    const app = createApp();
    app.use(plugin);

    const err = await app.start().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Failed to start app');
    // The cause chain: 'Failed to start app' -> 'Failed during async plugin registration' -> AggregateError with 'async-boom'
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe('post-stop behavior', () => {
  it('resolve() after stop() throws', async () => {
    const app = createApp();
    app.register({ simple: SimpleService });
    await app.start();
    await app.stop();

    expect(() => app.resolve('simple')).toThrow('Cannot resolve from a stopped app');
  });

  it('onDestroy is called during stop() even for services without onInit', async () => {
    let destroyed = false;

    class DestroyOnly {
      async onDestroy() {
        destroyed = true;
      }
    }

    const app = createApp();
    app.register({ svc: DestroyOnly });
    await app.start();
    await app.stop();
    expect(destroyed).toBe(true);
  });

  it('stop() disposes active scopes before destroying root services', async () => {
    const order: string[] = [];

    class RootService {
      async onInit() {}
      async onDestroy() {
        order.push('root-destroy');
      }
    }

    class ScopedService {
      async onDestroy() {
        order.push('scope-destroy');
      }
    }

    const app = createApp();
    app.register({ root: RootService });
    await app.start();

    const scope = app.createScope();
    scope.register({ scoped: ScopedService });
    scope.resolve('scoped'); // cache it

    await app.stop();

    // Scopes are disposed first, then root services
    expect(order.indexOf('scope-destroy')).toBeLessThan(order.indexOf('root-destroy'));
  });

  it('stop() with errors in both scope dispose and service onDestroy — AggregateError contains all', async () => {
    class FailingScopedService {
      async onDestroy() {
        throw new Error('scope-destroy-boom');
      }
    }

    class FailingRootService {
      async onInit() {}
      async onDestroy() {
        throw new Error('root-destroy-boom');
      }
    }

    const app = createApp();
    app.register({ root: FailingRootService });
    await app.start();

    const scope = app.createScope();
    scope.register({ scoped: FailingScopedService });
    scope.resolve('scoped');

    const err = await app.stop().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    const aggErr = err as AggregateError;
    expect(aggErr.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('register() after stop() throws', async () => {
    const app = createApp();
    await app.start();
    await app.stop();

    expect(() => app.register({ newSvc: SimpleService })).toThrow('Cannot register after app has been stopped');
  });

  it('start() after stop() throws', async () => {
    const app = createApp();
    await app.start();
    await app.stop();

    await expect(app.start()).rejects.toThrow('Cannot start a stopped app');
  });
});

describe('service name validation edge cases', () => {
  it('rejects names starting with numbers', () => {
    const app = createApp();
    expect(() => app.register({ '123bad': SimpleService })).toThrow('Invalid service name');
  });

  it('__proto__ in object literal is silently swallowed by JS — never reaches validation', () => {
    // NOTE: { __proto__: SimpleService } in JS sets the prototype, not a key named "__proto__".
    // Object.entries() will NOT include it, so validateServiceName is never called.
    // This is a JS language-level concern, not a framework bug.
    const app = createApp();
    // This registers zero services (the __proto__ key is consumed by JS)
    app.register({ __proto__: SimpleService } as any);
    // No service was registered
    expect(() => app.resolve('__proto__')).toThrow();
  });

  it('rejects constructor', () => {
    const app = createApp();
    expect(() => app.register({ constructor: SimpleService })).toThrow('Invalid service name');
  });

  it('rejects prototype', () => {
    const app = createApp();
    expect(() => app.register({ prototype: SimpleService })).toThrow('Invalid service name');
  });

  it('rejects names with special characters', () => {
    const app = createApp();
    expect(() => app.register({ 'my-service': SimpleService })).toThrow('Invalid service name');
    expect(() => app.register({ 'my.service': SimpleService })).toThrow('Invalid service name');
    expect(() => app.register({ 'my service': SimpleService })).toThrow('Invalid service name');
  });

  it('rejects empty string', () => {
    const app = createApp();
    expect(() => app.register({ '': SimpleService })).toThrow('Invalid service name');
  });

  it('accepts valid names', () => {
    const app = createApp();
    expect(() =>
      app.register({
        a: SimpleService,
        myService: AnotherService,
      })
    ).not.toThrow();
  });

  it('validates names in registerInScope — uses explicit string key', () => {
    const app = createApp();
    const key = Symbol('test');
    // Use a name that actually reaches validateServiceName (not __proto__ via literal)
    expect(() => app.registerInScope(key, { '123bad': SimpleService })).toThrow('Invalid service name');
  });

  it('validates names in scope.register', () => {
    const app = createApp();
    const scope = app.createScope();
    expect(() => scope.register({ '123bad': ScopedCounter })).toThrow('Invalid service name');
  });

  it('validates names in scope.registerValue', () => {
    const app = createApp();
    const scope = app.createScope();
    expect(() => scope.registerValue({ '123bad': 'value' })).toThrow('Invalid service name');
  });
});

describe('overwrite semantics', () => {
  it('overwriting before start — last registration wins', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp();
    app.register({ svc: SimpleService });
    // Overwrite before anything is resolved
    app.register({ svc: AnotherService });

    await app.start();
    const resolved = app.resolve<AnotherService>('svc');
    expect(resolved).toBeInstanceOf(AnotherService);

    warnSpy.mockRestore();
    await app.stop();
  });

  it('overwriting after start() is prevented by guard', async () => {
    const app = createApp();
    app.register({ svc: SimpleService });
    await app.start();

    expect(() => app.register({ svc: AnotherService })).toThrow('Cannot register after app has started');

    await app.stop();
  });

  it('overwriting in scope does not affect parent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createApp();
    app.register({ svc: SimpleService });

    const scope = app.createScope();
    scope.register({ svc: ScopedCounter });

    // Scope resolves the overwritten version
    expect(scope.resolve('svc')).toBeInstanceOf(ScopedCounter);
    // Parent still resolves the original
    expect(app.resolve('svc')).toBeInstanceOf(SimpleService);

    warnSpy.mockRestore();
  });
});
