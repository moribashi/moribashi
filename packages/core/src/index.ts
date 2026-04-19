import { hasOnDestroy, hasOnInit } from '@moribashi/common';
import {
  type AwilixContainer,
  asClass,
  asFunction,
  asValue,
  createContainer,
  InjectionMode,
  Lifetime,
  type Resolver,
} from 'awilix';

export type { AwilixContainer };
export { asClass, asFunction, asValue, Lifetime };

/**
 * Default auto-scan name formatter.
 *
 * Converts kebab/dot-segmented module basenames into camelCase container keys
 * using the project convention: `books.svc` → `booksService`, `books.repo` →
 * `booksRepo`, `mailer` → `mailer`. Unknown suffixes are appended verbatim.
 */
const defaultFormatName = (name: string): string => {
  const suffixMap: Record<string, string> = { svc: 'Service', repo: 'Repo' };
  const parts = name.split('.');
  const base = parts[0];
  const suffix = parts.length > 1 ? (suffixMap[parts[1]] ?? parts[1]) : '';
  return base + suffix;
};

/**
 * Options accepted by {@link MoribashiApp.scan}.
 *
 * @experimental The scan surface may evolve as auto-loading ergonomics settle.
 *
 * @property cwd        Base directory the glob patterns are resolved against.
 *                      Defaults to the current working directory.
 * @property formatName Maps a discovered module's basename to the container
 *                      registration key. Defaults to the project convention
 *                      (`books.svc` → `booksService`, `books.repo` → `booksRepo`).
 */
export interface ScanOptions {
  cwd?: string;
  formatName?: (name: string, descriptor: { path: string; value: unknown }) => string;
}

/**
 * A Moribashi plugin — a small, named unit that registers services or wires
 * third-party libraries into the root container.
 *
 * Plugins receive the {@link MoribashiApp} during `register()` and may call
 * `app.register(...)`, `app.container.register(...)`, or
 * `app.registerInScope(...)` to contribute. `register` may be async; its
 * promise is awaited during `app.start()` before singletons are resolved.
 *
 * @public
 *
 * @example
 * ```ts
 * import { asValue, type MoribashiPlugin } from '@moribashi/core';
 *
 * export function clockPlugin(): MoribashiPlugin {
 *   return {
 *     name: 'clock',
 *     register(app) {
 *       app.container.register({ now: asValue(() => new Date()) });
 *     },
 *   };
 * }
 * ```
 */
export interface MoribashiPlugin {
  name: string;
  register(app: MoribashiApp): void | Promise<void>;
}

/**
 * A child Awilix scope with `SCOPED` lifetime caching, typed via its `Cradle`.
 *
 * Use scopes for per-request, per-event, or per-job isolation. Scoped services
 * are cached for the life of the scope; calling {@link MoribashiScope.dispose}
 * fires `onDestroy` on every scoped instance and then disposes the underlying
 * Awilix scope.
 *
 * The `Cradle` type parameter declares the services available via
 * `scope.cradle.*`. Property access on `cradle` lazily resolves the service
 * (this is the same proxy behavior as Awilix).
 *
 * @public
 *
 * @example
 * ```ts
 * interface RequestCradle {
 *   currentUser: CurrentUser;
 *   booksService: BooksService;
 * }
 *
 * const scope = app.createScope<RequestCradle>(Symbol.for('moribashi.scope.http'));
 * scope.register({ currentUser: CurrentUser });
 * const books = await scope.cradle.booksService.findAllWithAuthors();
 * await scope.dispose();
 * ```
 */
export interface MoribashiScope<Cradle extends object = object> {
  /** Resolve a service by cradle key (typed) or by arbitrary string name. */
  resolve<K extends keyof Cradle & string>(name: K): Cradle[K];
  resolve<T>(name: string): T;
  /** Lazy proxy — property access resolves the corresponding service. */
  readonly cradle: Cradle;
  /**
   * Register additional classes as `SCOPED` in this scope only. Returns the
   * scope for chaining.
   */
  register(services: Record<string, new (...args: any[]) => any>): MoribashiScope<Cradle>;
  /**
   * Fire `onDestroy` on every cached scoped instance and dispose the underlying
   * Awilix scope. Safe to call multiple times indirectly via `app.stop()`.
   */
  dispose(): Promise<void>;
  /** Escape hatch — the raw Awilix scope for advanced use. */
  container: AwilixContainer<Cradle>;
}

/**
 * The Moribashi application handle returned by {@link createApp}.
 *
 * Wraps an Awilix root container and tracks plugins, scoped registrations,
 * and initialization order so that `start()` can eagerly boot singletons and
 * `stop()` can tear them down deterministically.
 *
 * @public
 */
export interface MoribashiApp {
  /**
   * Register one or more classes as `SINGLETON` on the root container.
   *
   * Keys are the cradle names consumers will inject — typically camelCase
   * (`booksService`, `booksRepo`). Returns the app for chaining.
   *
   * @example
   * ```ts
   * app.register({ booksService: BooksService, booksRepo: BooksRepo });
   * ```
   */
  register(services: Record<string, new (...args: any[]) => any>): MoribashiApp;
  /** Resolve a service from the root container. */
  resolve<T>(name: string): T;
  /**
   * Auto-load modules matching the given glob patterns and register each
   * default export as a `SINGLETON`. Powered by `awilix.loadModules`.
   *
   * @experimental
   *
   * @param patterns Glob patterns relative to `opts.cwd`.
   * @param opts     See {@link ScanOptions}.
   * @returns        The app, for chaining.
   *
   * @example
   * ```ts
   * await app.scan(['**\/*.repo.ts', '**\/*.svc.ts'], { cwd: __dirname });
   * ```
   */
  scan(patterns: string[], opts?: ScanOptions): Promise<MoribashiApp>;
  /**
   * Attach a plugin. `plugin.register(app)` runs synchronously; if it returns
   * a promise, that promise is awaited during {@link MoribashiApp.start}
   * before any singleton is resolved.
   *
   * @example
   * ```ts
   * app.use(pgPlugin({ host: 'localhost', database: 'myapp' }));
   * ```
   */
  use(plugin: MoribashiPlugin): MoribashiApp;
  /**
   * Queue class registrations to be applied whenever a scope is created via
   * `createScope(scopeKey)` with the matching key.
   *
   * Named scopes are identified by a `symbol` — by convention
   * `Symbol.for('moribashi.scope.<name>')` so that different modules agree on
   * the same key.
   *
   * @example
   * ```ts
   * const HTTP_SCOPE = Symbol.for('moribashi.scope.http');
   * app.registerInScope(HTTP_SCOPE, { currentUser: CurrentUser });
   * // later, per-request:
   * const scope = app.createScope(HTTP_SCOPE);
   * ```
   */
  registerInScope(
    scopeKey: symbol,
    services: Record<string, new (...args: any[]) => any>,
  ): MoribashiApp;
  /**
   * Create a child scope. If `scopeKey` is provided, any services previously
   * queued with {@link MoribashiApp.registerInScope} for that key are applied.
   *
   * @typeParam ScopeCradle The cradle shape exposed on `scope.cradle`.
   *
   * @example
   * ```ts
   * const scope = app.createScope<{ currentUser: CurrentUser }>(HTTP_SCOPE);
   * try {
   *   await handler(scope.cradle);
   * } finally {
   *   await scope.dispose();
   * }
   * ```
   */
  createScope<ScopeCradle extends object = object>(scopeKey?: symbol): MoribashiScope<ScopeCradle>;
  /**
   * Finish wiring and boot the app:
   *
   * 1. Await any pending async plugin registrations.
   * 2. Eagerly resolve every `SINGLETON` (so construction errors surface now,
   *    not on first request).
   * 3. Call `onInit()` on each resolved instance that implements it (duck-typed).
   *
   * Throws if called twice. Initialization order matches registration order
   * and is remembered for the reverse-order `stop()` pass.
   */
  start(): Promise<void>;
  /**
   * Tear the app down:
   *
   * 1. Dispose every active scope (firing their `onDestroy` hooks).
   * 2. Call `onDestroy()` on singletons in **reverse** initialization order.
   * 3. Dispose the root Awilix container.
   *
   * A no-op if `start()` was never called. Typically wired to `SIGINT`/`SIGTERM`.
   */
  stop(): Promise<void>;
  /** Escape hatch — the raw Awilix root container for advanced use. */
  container: AwilixContainer;
}

/**
 * Create a new Moribashi app.
 *
 * Returns a {@link MoribashiApp} wrapping a fresh Awilix container configured
 * with `PROXY` injection mode and `strict: true`. Services are registered as
 * `SINGLETON` by default; scoped services use `SCOPED`.
 *
 * Typical flow: `createApp()` → `use(...)` plugins → `register(...)` / `scan(...)`
 * your own services → `await app.start()` → serve traffic → `await app.stop()`
 * on shutdown.
 *
 * @public
 *
 * @returns A fresh {@link MoribashiApp} handle.
 *
 * @example
 * ```ts
 * import { createApp } from '@moribashi/core';
 * import type { OnInit, OnDestroy } from '@moribashi/common';
 *
 * class GreeterService implements OnInit, OnDestroy {
 *   onInit() { console.log('ready'); }
 *   greet(who: string) { return `hello, ${who}`; }
 *   async onDestroy() { console.log('bye'); }
 * }
 *
 * const app = createApp();
 * app.register({ greeterService: GreeterService });
 *
 * await app.start();
 * app.resolve<GreeterService>('greeterService').greet('world');
 * await app.stop();
 * ```
 */
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

  function createMoribashiScope<Cradle extends object = object>(
    awilixScope: AwilixContainer<Cradle>,
  ): MoribashiScope<Cradle> {
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

/** Returns package identity metadata — intended for debugging only. */
export function diagnostics(): any {
  return {
    module: '@moribashi/core',
  };
}
