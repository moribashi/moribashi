import type { MoribashiApp } from '@moribashi/core';
import { HandlerBindingError } from './errors.js';
import type { EventMessage, EventScope } from './scope.js';
import type { Logger } from './schemas.js';

/** What a handler is called with: the decoded message and its DI scope. */
export type EventHandlerFn<T = unknown> = (
  event: EventMessage<T>,
  scope: EventScope,
) => void | Promise<void>;

/**
 * A convention-discovered handler. Put it in `<name>.handler.ts` and let the
 * service's `app.scan()` pick it up — the same mechanism `*.svc.ts` and
 * `*.repo.ts` already use, with core's `formatName` turning
 * `identity.handler.ts` into the container name `identityHandler`.
 *
 * The handler declares the topic it binds to, so binding needs no extra
 * registry:
 *
 * ```ts
 * export default class IdentityHandler implements EventHandler<IdentityCreated> {
 *   readonly topic = 'iam.identity.created.v1';
 *   constructor({ identityService }: { identityService: IdentityService }) { … }
 *   async handle(event: EventMessage<IdentityCreated>, scope: EventScope) { … }
 * }
 * ```
 */
export interface EventHandler<T = unknown> {
  /** Topic, or topics, this handler binds to. */
  readonly topic: string | string[];
  handle: EventHandlerFn<T>;
}

/**
 * An explicit binding: a container name to resolve, a handler object, or a
 * bare function. The DI name is the documented path — it keeps handlers
 * constructor-injected like everything else.
 */
export type HandlerBinding = string | EventHandler | EventHandlerFn;

/** Explicit topic → handler map, highest precedence. */
export type HandlerMap = Record<string, HandlerBinding>;

export interface ResolvedHandler {
  topic: string;
  /** Container name, or a synthetic label for inline handlers. */
  name: string;
  handle: EventHandlerFn;
  source: 'explicit' | 'convention';
}

/** Container names ending in `Handler` — what `*.handler.ts` scans to. */
export const DEFAULT_CONVENTION_PATTERN = /Handler$/;

export function isEventHandler(value: unknown): value is EventHandler {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<EventHandler>;
  if (typeof candidate.handle !== 'function') return false;
  return (
    typeof candidate.topic === 'string' ||
    (Array.isArray(candidate.topic) &&
      candidate.topic.length > 0 &&
      candidate.topic.every(t => typeof t === 'string'))
  );
}

function topicsOf(handler: EventHandler): string[] {
  return typeof handler.topic === 'string' ? [handler.topic] : [...handler.topic];
}

function bindingToFn(binding: HandlerBinding, topic: string, app: MoribashiApp): {
  name: string;
  handle: EventHandlerFn;
} {
  if (typeof binding === 'string') {
    let resolved: unknown;
    try {
      resolved = app.resolve<unknown>(binding);
    } catch (cause) {
      throw new HandlerBindingError(
        `No service named "${binding}" is registered for topic "${topic}". ` +
          'Register it, or scan the directory its *.handler.ts lives in.',
        topic,
        { cause },
      );
    }
    if (typeof resolved === 'function') {
      return { name: binding, handle: resolved as EventHandlerFn };
    }
    if (resolved !== null && typeof resolved === 'object' &&
        typeof (resolved as EventHandler).handle === 'function') {
      const handler = resolved as EventHandler;
      return { name: binding, handle: handler.handle.bind(handler) };
    }
    throw new HandlerBindingError(
      `Service "${binding}" bound to topic "${topic}" is not a handler — ` +
        'it needs a `handle(event, scope)` method, or must itself be a function.',
      topic,
    );
  }

  if (typeof binding === 'function') {
    return { name: binding.name || '<inline>', handle: binding as EventHandlerFn };
  }

  if (typeof binding?.handle === 'function') {
    return { name: '<inline>', handle: binding.handle.bind(binding) };
  }

  throw new HandlerBindingError(
    `Binding for topic "${topic}" is not a handler — expected a container ` +
      'name, a function, or an object with a `handle` method.',
    topic,
  );
}

export interface ResolveHandlerBindingsOptions {
  app: MoribashiApp;
  /** Explicit topic → handler map. Wins over convention on conflict. */
  handlers?: HandlerMap;
  /**
   * Discover `*.handler.ts` handlers from the container. `true` uses the
   * default `/Handler$/` name pattern; pass a RegExp to narrow it; `false`
   * turns convention off entirely.
   */
  convention?: boolean | RegExp;
  log?: Logger;
}

/**
 * Resolves the topic → handler table from both binding styles.
 *
 * Explicit entries win on conflict — the map is what someone wrote down on
 * purpose. Two *convention* handlers claiming one topic is a startup error,
 * not last-one-wins: which of two handlers runs would otherwise depend on
 * filesystem ordering, and the loser would fail silently forever.
 *
 * Runs at `onInit`, not at plugin `register()`, so a service is free to call
 * `app.scan()` after `app.use(kafkaConsumerPlugin(…))`.
 */
export function resolveHandlerBindings(
  opts: ResolveHandlerBindingsOptions,
): Map<string, ResolvedHandler> {
  const { app, handlers = {}, convention = true, log } = opts;
  const bindings = new Map<string, ResolvedHandler>();

  for (const [topic, binding] of Object.entries(handlers)) {
    const { name, handle } = bindingToFn(binding, topic, app);
    bindings.set(topic, { topic, name, handle, source: 'explicit' });
  }

  if (convention !== false) {
    const pattern = convention === true ? DEFAULT_CONVENTION_PATTERN : convention;
    // Sorted so a double-bind reports the same two names every run.
    const names = Object.keys(app.container.registrations).filter(n => pattern.test(n)).sort();

    for (const name of names) {
      let candidate: unknown;
      try {
        candidate = app.resolve<unknown>(name);
      } catch (cause) {
        // Something matching the handler name pattern exists but cannot be
        // built. Silently skipping it would hide a genuinely broken handler,
        // and letting the raw container error through says nothing about why
        // we were resolving it in the first place.
        throw new HandlerBindingError(
          `Convention discovery could not resolve "${name}": ${(cause as Error).message}. ` +
            'If it is not an event handler, narrow `convention` to a stricter ' +
            'pattern or set it to false and bind handlers explicitly.',
          undefined,
          { cause },
        );
      }
      if (!isEventHandler(candidate)) continue;

      for (const topic of topicsOf(candidate)) {
        const existing = bindings.get(topic);
        if (existing?.source === 'explicit') {
          log?.info(
            { topic, explicit: existing.name, convention: name },
            'Explicit handler binding overrides the convention-discovered one',
          );
          continue;
        }
        if (existing) {
          throw new HandlerBindingError(
            `Topic "${topic}" is bound by two handlers: "${existing.name}" and ` +
              `"${name}". Convention binding is unambiguous by design — remove one, ` +
              'or bind the winner explicitly in the `handlers` map.',
            topic,
          );
        }
        bindings.set(topic, {
          topic,
          name,
          handle: candidate.handle.bind(candidate),
          source: 'convention',
        });
      }
    }
  }

  if (bindings.size === 0) {
    throw new HandlerBindingError(
      'No handlers bound. Pass a `handlers` map, or register *.handler.ts ' +
        'services (e.g. `await app.scan(["**/*.handler.ts"])`) before app.start().',
    );
  }

  return bindings;
}
