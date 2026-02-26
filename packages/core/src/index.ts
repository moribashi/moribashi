import { createContainer, asClass, asFunction, asValue, Lifetime, InjectionMode, type AwilixContainer, type Resolver } from 'awilix';
import { hasOnInit, hasOnDestroy } from '@moribashi/common';

export type { AwilixContainer };
export { asClass, asFunction, asValue, Lifetime };

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
  register(app: MoribashiApp): void | Promise<void>;
}

export interface MoribashiScope<Cradle extends object = object> {
  resolve<K extends keyof Cradle & string>(name: K): Cradle[K];
  resolve<T>(name: string): T;
  readonly cradle: Cradle;
  register(services: Record<string, new (...args: any[]) => any>): MoribashiScope<Cradle>;
  dispose(): Promise<void>;
  container: AwilixContainer<Cradle>;
}

export interface MoribashiApp {
  register(services: Record<string, new (...args: any[]) => any>): MoribashiApp;
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

  const pendingRegistrations: Promise<void>[] = [];
  const scopeRegistrations = new Map<symbol, Array<[string, Resolver<unknown>]>>();
  const activeScopes = new Set<MoribashiScope<any>>();
  const initializedServices: Array<{ name: string; instance: unknown }> = [];
  let started = false;

  function createMoribashiScope<Cradle extends object = object>(awilixScope: AwilixContainer<Cradle>): MoribashiScope<Cradle> {
    const scope: MoribashiScope<Cradle> = {
      resolve(name: string): any {
        return awilixScope.resolve(name);
      },
      get cradle() {
        return awilixScope.cradle;
      },
      register(services) {
        for (const [name, ctor] of Object.entries(services)) {
          awilixScope.register(name, asClass(ctor).setLifetime(Lifetime.SCOPED));
        }
        return scope;
      },
      async dispose() {
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
      for (const [name, ctor] of Object.entries(services)) {
        container.register(name, asClass(ctor).setLifetime(Lifetime.SINGLETON));
      }
      return app;
    },
    resolve<T>(name: string): T {
      return container.resolve<T>(name);
    },
    async scan(patterns, opts = {}) {
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
      const result = plugin.register(app);
      if (result && typeof result.then === 'function') {
        pendingRegistrations.push(result);
      }
      return app;
    },
    registerInScope(scopeKey, services) {
      let entries = scopeRegistrations.get(scopeKey);
      if (!entries) {
        entries = [];
        scopeRegistrations.set(scopeKey, entries);
      }
      for (const [name, ctor] of Object.entries(services)) {
        entries.push([name, asClass(ctor).setLifetime(Lifetime.SCOPED)]);
      }
      return app;
    },
    createScope<ScopeCradle extends object = object>(scopeKey?: symbol) {
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
      if (started) throw new Error('App already started');

      // 1. Await any async plugin registrations
      if (pendingRegistrations.length > 0) {
        await Promise.all(pendingRegistrations);
        pendingRegistrations.length = 0;
      }

      // 2. Eagerly resolve all singletons and call onInit
      for (const [name, registration] of Object.entries(container.registrations)) {
        if (registration.lifetime === Lifetime.SINGLETON) {
          const instance = container.resolve(name);
          initializedServices.push({ name, instance });
          if (hasOnInit(instance)) {
            await instance.onInit();
          }
        }
      }

      started = true;
    },
    async stop() {
      if (!started) return;

      // 1. Dispose all active scopes
      for (const scope of activeScopes) {
        await scope.dispose();
      }

      // 2. Call onDestroy in reverse initialization order
      for (const { instance } of [...initializedServices].reverse()) {
        if (hasOnDestroy(instance)) {
          await instance.onDestroy();
        }
      }

      // 3. Dispose root container
      await container.dispose();

      started = false;
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
