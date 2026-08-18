/**
 * Error taxonomy for @moribashi/kafka.
 *
 * Every failure this package raises on its own is a `KafkaError`, so a
 * service can distinguish "the transport is misconfigured / the contract is
 * broken" from a broker-level error thrown by `@platformatic/kafka`.
 *
 * All three subclasses are *boot-time-loud* by design: config problems and
 * schema-registration problems surface before the app finishes starting, so
 * the pod crashloops instead of running with a broken contract.
 */

export class KafkaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Configuration is missing, malformed, or internally inconsistent. Thrown
 * eagerly from `createKafkaConfig()` — never later, from a send.
 */
export class KafkaConfigError extends KafkaError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * A `.proto` file could not be registered for its subject. The common cause
 * is an incompatible change: the registry rejected the new schema against the
 * subject's compatibility policy.
 */
export class SchemaRegistrationError extends KafkaError {
  readonly subject: string;
  readonly file?: string;

  constructor(
    message: string,
    subject: string,
    file?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.subject = subject;
    this.file = file;
  }
}

/**
 * A message could not be turned into a Confluent-framed payload: the subject
 * has no registered schema, the registry was unreachable, or the value does
 * not satisfy the registered message type.
 */
export class SchemaEncodeError extends KafkaError {
  readonly topic: string;
  readonly subject: string;
  readonly schemaId?: number;

  constructor(
    message: string,
    topic: string,
    subject: string,
    schemaId?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.topic = topic;
    this.subject = subject;
    this.schemaId = schemaId;
  }
}

/**
 * A consumed message could not be decoded: the registry was unreachable, the
 * bytes carry no Confluent framing, or the schema id in them is unknown.
 * Routed through the consumer's failure policy exactly like a handler throw —
 * an undecodable message is as poisonous as an unprocessable one.
 */
export class SchemaDecodeError extends KafkaError {
  readonly topic: string;
  readonly partition: number;
  readonly offset: bigint;

  constructor(
    message: string,
    topic: string,
    partition: number,
    offset: bigint,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.topic = topic;
    this.partition = partition;
    this.offset = offset;
  }
}

/**
 * A handler threw for a message and every retry was exhausted. Carries the
 * message's coordinates and the attempt count so the failure can be found in
 * the log and replayed from the DLQ.
 */
export class EventHandlerError extends KafkaError {
  readonly topic: string;
  readonly partition: number;
  readonly offset: bigint;
  readonly attempts: number;

  constructor(
    message: string,
    topic: string,
    partition: number,
    offset: bigint,
    attempts: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.topic = topic;
    this.partition = partition;
    this.offset = offset;
    this.attempts = attempts;
  }
}

/**
 * Handlers could not be bound to topics at startup — no handler at all, or
 * two handlers claiming one topic by convention. Thrown from `app.start()`,
 * never at message time: an ambiguous binding is a wiring bug, and last-one-
 * wins would make it invisible.
 */
export class HandlerBindingError extends KafkaError {
  readonly topic?: string;

  constructor(message: string, topic?: string, options?: ErrorOptions) {
    super(message, options);
    this.topic = topic;
  }
}
