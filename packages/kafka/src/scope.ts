import { randomUUID } from 'node:crypto';
import type { MoribashiScope } from '@moribashi/core';

/**
 * Key for the per-message DI scope, the event-side counterpart of
 * `@moribashi/web`'s `WEB_REQUEST_SCOPE`. Services register into it the same
 * way:
 *
 * ```ts
 * app.registerInScope(EVENT_SCOPE, { auditLog: AuditLog });
 * ```
 */
export const EVENT_SCOPE = Symbol.for('moribashi.scope.event');

/**
 * Header carrying a correlation id across a produce → consume hop. Chosen
 * because `x-correlation-id` is what the HTTP side of the platform already
 * uses, so one id can span a request and the events it causes. Configurable
 * per consumer via `correlationIdHeader`.
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** One consumed message, decoded and with its Kafka coordinates attached. */
export interface EventMessage<T = unknown> {
  topic: string;
  partition: number;
  offset: bigint;
  /** UTF-8 view of the partition key, when the message has one. */
  key?: string;
  /** The key exactly as it arrived — binary keys survive here. */
  rawKey?: Buffer;
  /** Decoded against the topic's registered value schema. */
  value: T;
  /** The value exactly as it arrived, Confluent framing included. */
  rawValue?: Buffer;
  headers: Record<string, string>;
  timestamp?: bigint;
  /** From the correlation header when present, otherwise generated. */
  correlationId: string;
  /** 1-based delivery attempt within this process. */
  attempt: number;
}

/**
 * What every event scope carries. Declaration-merge into it to type the
 * services a service registers with `app.registerInScope(EVENT_SCOPE, …)`:
 *
 * ```ts
 * declare module '@moribashi/kafka' {
 *   interface EventCradle {
 *     auditLog: AuditLog;
 *   }
 * }
 * ```
 */
export interface EventCradle {
  event: EventMessage;
  correlationId: string;
}

/** The scope handed to a handler for the message it is processing. */
export type EventScope = MoribashiScope<EventCradle>;

/**
 * Reads the correlation id from a message's headers, falling back to a fresh
 * UUID. Header lookup is case-insensitive: Kafka headers are bytes, so
 * casing is whatever the producer happened to write.
 */
export function correlationIdFrom(
  headers: Record<string, string>,
  header: string = CORRELATION_ID_HEADER,
): string {
  const wanted = header.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === wanted && value) return value;
  }
  return randomUUID();
}
