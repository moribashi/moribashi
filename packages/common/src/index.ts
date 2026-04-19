/**
 * Lifecycle hook invoked by the Moribashi core after a service is resolved
 * during `app.start()`. Implementations may be sync or async; async
 * `onInit`s are awaited in registration order before the app is considered
 * started.
 *
 * Duck-typed — classes do not need to declare `implements OnInit`, the core
 * checks with {@link hasOnInit} at runtime.
 *
 * @public
 */
export interface OnInit {
  onInit(): Promise<void> | void;
}

/**
 * Lifecycle hook invoked by the Moribashi core during `app.stop()`. Called
 * in reverse init order so services can release resources before their
 * dependencies do. Sync or async.
 *
 * Duck-typed — the core detects it via {@link hasOnDestroy}.
 *
 * @public
 */
export interface OnDestroy {
  onDestroy(): Promise<void> | void;
}

/**
 * Runtime type guard: returns `true` when `value` has a callable `onInit`
 * method. Used by the core to decide whether to fire the init lifecycle on
 * a resolved service.
 *
 * @param value Any resolved service instance.
 * @returns `true` if `value` duck-types as {@link OnInit}.
 *
 * @example
 * ```ts
 * import { hasOnInit } from '@moribashi/common';
 *
 * const svc = container.resolve('booksService');
 * if (hasOnInit(svc)) await svc.onInit();
 * ```
 *
 * @public
 */
export function hasOnInit(value: unknown): value is OnInit {
  return value != null && typeof (value as any).onInit === 'function';
}

/**
 * Runtime type guard: returns `true` when `value` has a callable
 * `onDestroy` method. Used by the core to decide whether to fire the
 * destroy lifecycle on shutdown.
 *
 * @param value Any resolved service instance.
 * @returns `true` if `value` duck-types as {@link OnDestroy}.
 *
 * @example
 * ```ts
 * import { hasOnDestroy } from '@moribashi/common';
 *
 * const svc = container.resolve('booksService');
 * if (hasOnDestroy(svc)) await svc.onDestroy();
 * ```
 *
 * @public
 */
export function hasOnDestroy(value: unknown): value is OnDestroy {
  return value != null && typeof (value as any).onDestroy === 'function';
}

/**
 * Package identity probe. Returns `{ module: '@moribashi/common' }` so
 * tooling can verify which copy of the package is loaded at runtime.
 *
 * @returns An object identifying this package.
 *
 * @public
 */
export function diagnostics(): any {
  return {
    module: '@moribashi/common',
  };
}
