import { createContainer, asClass, asFunction, asValue, Lifetime, InjectionMode, type AwilixContainer, type Resolver } from 'awilix';
import { hasOnInit, hasOnDestroy } from '@moribashi/common';

export type { AwilixContainer };
export { asClass, asFunction, asValue, Lifetime };

const DANGEROUS_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const SERVICE_NAME_RE = /^[a-zA-Z][a-zA-Z0-9]*$/;

function validateServiceName(name: string): void {
  if (DANGEROUS_NAMES.has(name) || !SERVICE_NAME_RE.test(name)) {
    throw new Error(`Invalid service name '${name}': must start with a letter and contain only alphanumeric characters`);
  }
}

const defaultFormatName = (name: string): string => {
  const suffixMap: Record<string, string> = { svc: 'Service', repo: 'Repo' };
  const parts = name.split('.');
  const base = parts[0];
  const suffix = parts.length > 1 ? (suffixMap[parts[1]] ?? parts[1]) : '';
  return base + suffix;
};

export interface ScanOptions {
  cwd?: string;
  formatName?: (name: string, descriptor: { path: string; value: unknown }) => string;
}

export interface MoribashiPlugin {
  name: string;
  dependencies?: string[];
  register(app: MoribashiApp): void | Promise<void>;
}

export interface MoribashiScope<Cradle extends object = object> {
  resolve<K extends keyof Cradle & string>(name: K): Cradle[K];
  resolve<T>(name: string): T;
  readonly cradle: Cradle;
  register(services: Record<string, new (...args: any[]) => any>): MoribashiScope<Cradle>;
  registerValue(services: Record<string, unknown>): MoribashiScope<Cradle>;
  dispose(): Promise<void>;
  container: AwilixContainer<Cradle>;
}

export interface MoribashiApp {
  register(services: Record<string, new (...args: any[]) => any>): MoribashiApp;
  registerValue(services: Record<string, unknown>): MoribashiApp;
  registerFactory(services: Record<string, (...args: any[]) => unknown>): MoribashiApp;
  resolve<T>(name: string): T;
  scan(patterns: string[], opts?: ScanOptions): Promise<MoribashiApp>;
  use(plugin: MoribashiPlugin): MoribashiApp;
  registerInScope(scopeKey: symbol, services: Record<string, new (...args: any[]) => any>): MoribashiApp;
  createScope<ScopeCradle extends object = object>(scopeKey?: symbol): MoribashiScope<ScopeCradle>;
  start(): Promise<void>;
  stop(): Promise<void>;
  container: AwilixContainer;
}

export function createApp(): MoribashiApp {
  const container = createContainer({
    injectionMode: InjectionMode.PROXY,
    strict: true,
  });

  const registeredPlugins = new Set<string>();
  const pendingRegistrations: Promise<void>[] = [];
  const scopeRegistrations = new Map<symbol, Array<[string, Resolver<unknown>]>>();
  const activeScopes = new Set<MoribashiScope<any>>();
  const initializedServices: Array<{ name: string; instance: unknown }> = [];
  let started = false;
  let starting = false;
  let stopping = false;
  let stopped = false;

  function assertMutable(action: string): void {
    if (started) throw new Error(`Cannot ${action} after app has started`);
    if (stopped) throw new Error(`Cannot ${action} after app has been stopped`);
  }

  function createMoribashiScope<Cradle extends object = object>(awilixScope: AwilixContainer<Cradle>): MoribashiScope<Cradle> {
    let disposed = false;
    const scope: MoribashiScope<Cradle> = {
      resolve(name: string): any {
        if (disposed) throw new Error('Cannot resolve from a disposed scope');
        return awilixScope.resolve(name);
      },
      get cradle() {
        if (disposed) throw new Error('Cannot access cradle of a disposed scope');
        return awilixScope.cradle;
      },
      register(services) {
        if (disposed) throw new Error('Cannot register on a disposed scope');
        for (const [name, ctor] of Object.entries(services)) {
          validateServiceName(name);
          if (awilixScope.registrations[name]) {
            console.warn(`[moribashi] Warning: overwriting existing service '${name}'`);
          }
          awilixScope.register(name, asClass(ctor).setLifetime(Lifetime.SCOPED));
        }
        return scope;
      },
      registerValue(services) {
        if (disposed) throw new Error('Cannot register on a disposed scope');
        for (const [name, value] of Object.entries(services)) {
          validateServiceName(name);
          if (awilixScope.registrations[name]) {
            console.warn(`[moribashi] Warning: overwriting existing service '${name}'`);
          }
          awilixScope.register(name, asValue(value));
        }
        return scope;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        // Call onDestroy on scoped cached services
        for (const [, entry] of awilixScope.cache) {
          if (hasOnDestroy(entry.value)) {
            await entry.value.onDestroy();
          }
        }
        activeScopes.delete(scope as MoribashiScope<any>);
        await awilixScope.dispose();
      },
      container: awilixScope,
    };

    activeScopes.add(scope as MoribashiScope<any>);
    return scope;
  }

  const app: MoribashiApp = {
    register(services) {
      assertMutable('register');
      for (const [name, ctor] of Object.entries(services)) {
        validateServiceName(name);
        if (container.registrations[name]) {
          console.warn(`[moribashi] Warning: overwriting existing service '${name}'`);
        }
        container.register(name, asClass(ctor).setLifetime(Lifetime.SINGLETON));
      }
      return app;
    },
    registerValue(services) {
      assertMutable('registerValue');
      for (const [name, value] of Object.entries(services)) {
        validateServiceName(name);
        if (container.registrations[name]) {
          console.warn(`[moribashi] Warning: overwriting existing service '${name}'`);
        }
        container.register(name, asValue(value));
      }
      return app;
    },
    registerFactory(services) {
      assertMutable('registerFactory');
      for (const [name, factory] of Object.entries(services)) {
        validateServiceName(name);
        if (container.registrations[name]) {
          console.warn(`[moribashi] Warning: overwriting existing service '${name}'`);
        }
        container.register(name, asFunction(factory).setLifetime(Lifetime.SINGLETON));
      }
      return app;
    },
    resolve<T>(name: string): T {
      if (stopped) throw new Error('Cannot resolve from a stopped app');
      return container.resolve<T>(name);
    },
    async scan(patterns, opts = {}) {
      assertMutable('scan');
      await container.loadModules(patterns, {
        cwd: opts.cwd,
        esModules: true,
        formatName: opts.formatName ?? defaultFormatName,
        resolverOptions: {
          lifetime: Lifetime.SINGLETON,
          injectionMode: InjectionMode.PROXY,
        },
      });
      return app;
    },
    use(plugin) {
      assertMutable('use');
      if (registeredPlugins.has(plugin.name)) {
        console.warn(`[moribashi] Warning: plugin '${plugin.name}' registered more than once`);
      }

      if (plugin.dependencies) {
        for (const dep of plugin.dependencies) {
          if (!registeredPlugins.has(dep)) {
            throw new Error(`Plugin '${plugin.name}' depends on '${dep}' which has not been registered. Register '${dep}' before '${plugin.name}'.`);
          }
        }
      }

      const result = plugin.register(app);
      if (result && typeof result.then === 'function') {
        pendingRegistrations.push(result);
      }

      registeredPlugins.add(plugin.name);
      return app;
    },
    registerInScope(scopeKey, services) {
      assertMutable('registerInScope');
      let entries = scopeRegistrations.get(scopeKey);
      if (!entries) {
        entries = [];
        scopeRegistrations.set(scopeKey, entries);
      }
      for (const [name, ctor] of Object.entries(services)) {
        validateServiceName(name);
        entries.push([name, asClass(ctor).setLifetime(Lifetime.SCOPED)]);
      }
      return app;
    },
    createScope<ScopeCradle extends object = object>(scopeKey?: symbol) {
      if (stopped) throw new Error('Cannot createScope after app has been stopped');
      const awilixScope = container.createScope<ScopeCradle>();

      if (scopeKey) {
        const entries = scopeRegistrations.get(scopeKey);
        if (entries) {
          for (const [name, resolver] of entries) {
            awilixScope.register(name, resolver);
          }
        }
      }

      return createMoribashiScope<ScopeCradle>(awilixScope);
    },
    async start() {
      if (stopped) throw new Error('Cannot start a stopped app');
      if (started || starting) throw new Error('App already started or starting');
      starting = true;

      try {
        // 1. Await any async plugin registrations
        if (pendingRegistrations.length > 0) {
          try {
            await Promise.all(pendingRegistrations);
          } catch (err) {
            throw new Error('Failed during async plugin registration', { cause: err });
          } finally {
            pendingRegistrations.length = 0;
          }
        }

        // 2. Eagerly resolve all singletons and call onInit
        for (const [name, registration] of Object.entries(container.registrations)) {
          if (registration.lifetime === Lifetime.SINGLETON) {
            const instance = container.resolve(name);
            if (hasOnInit(instance)) {
              await instance.onInit();
            }
            initializedServices.push({ name, instance });
          }
        }

        started = true;
        starting = false;
      } catch (err) {
        starting = false;
        // Clean up already-initialized services in reverse order
        for (const { instance } of [...initializedServices].reverse()) {
          try {
            if (hasOnDestroy(instance)) {
              await instance.onDestroy();
            }
          } catch {
            // best-effort cleanup
          }
        }
        initializedServices.length = 0;
        await container.dispose();
        throw new Error('Failed to start app', { cause: err });
      }
    },
    async stop() {
      if (!started || stopping) return;
      stopping = true;

      const errors: unknown[] = [];

      // 1. Dispose all active scopes
      for (const scope of [...activeScopes]) {
        try {
          await scope.dispose();
        } catch (err) {
          errors.push(err);
        }
      }

      // 2. Call onDestroy in reverse initialization order
      for (const { instance } of [...initializedServices].reverse()) {
        if (hasOnDestroy(instance)) {
          try {
            await instance.onDestroy();
          } catch (err) {
            errors.push(err);
          }
        }
      }

      // 3. Dispose root container
      try {
        await container.dispose();
      } catch (err) {
        errors.push(err);
      }

      started = false;
      stopping = false;
      stopped = true;

      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more errors occurred during stop');
      }
    },
    container,
  };

  return app;
}

export function diagnostics(): any {
  return {
    module: '@moribashi/core',
  };
}
