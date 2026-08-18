import { describe, it, expect } from 'vitest';
import * as barrel from '../index.js';

describe('index re-exports', () => {
  it('exports diagnostics', () => {
    expect(barrel.diagnostics()).toEqual({ module: '@moribashi/kafka' });
  });

  it.each([
    'createKafkaConfig',
    'createKafkaClient',
    'createSchemaRegistry',
    'buildConnectionOptions',
    'isKafkaClient',
    'registerSchemas',
    'readSchemaSources',
    'checkSchemaCompatibility',
    'subjectForFile',
    'subjectForTopic',
    'createProducer',
    'createConsumer',
    'kafkaPlugin',
    'kafkaConsumerPlugin',
    'resolveHandlerBindings',
    'isEventHandler',
    'correlationIdFrom',
    'logError',
  ])('exports %s as a function', name => {
    expect(typeof barrel[name as keyof typeof barrel]).toBe('function');
  });

  it.each([
    'KafkaError',
    'KafkaConfigError',
    'SchemaEncodeError',
    'SchemaRegistrationError',
    'SchemaDecodeError',
    'EventHandlerError',
    'HandlerBindingError',
  ])('exports the %s constructor', name => {
    expect(typeof barrel[name as keyof typeof barrel]).toBe('function');
  });

  it('exports the SASL mechanism list', () => {
    expect(barrel.SASL_MECHANISMS).toEqual([
      'oauthbearer',
      'scram-sha-256',
      'scram-sha-512',
      'plain',
    ]);
  });

  it('exports the schema file extension', () => {
    expect(barrel.SCHEMA_FILE_EXTENSION).toBe('.proto');
  });

  it('does not leak internals — every export is intentional', () => {
    expect(Object.keys(barrel).sort()).toEqual(
      [
        'CORRELATION_ID_HEADER',
        'DEFAULT_CONVENTION_PATTERN',
        'DLQ_HEADER_PREFIX',
        'EVENT_SCOPE',
        'EventHandlerError',
        'HandlerBindingError',
        'KafkaConfigError',
        'KafkaError',
        'SASL_MECHANISMS',
        'SCHEMA_FILE_EXTENSION',
        'SchemaDecodeError',
        'SchemaEncodeError',
        'SchemaRegistrationError',
        'buildConnectionOptions',
        'checkSchemaCompatibility',
        'correlationIdFrom',
        'createConsumer',
        'createKafkaClient',
        'createKafkaConfig',
        'createProducer',
        'createSchemaRegistry',
        'diagnostics',
        'isEventHandler',
        'isKafkaClient',
        'kafkaConsumerPlugin',
        'kafkaPlugin',
        'logError',
        'readSchemaSources',
        'registerSchemas',
        'resolveHandlerBindings',
        'subjectForFile',
        'subjectForTopic',
      ].sort(),
    );
  });
});

describe('error taxonomy', () => {
  const instances = [
    new barrel.KafkaConfigError('x'),
    new barrel.SchemaEncodeError('x', 't', 's'),
    new barrel.SchemaRegistrationError('x', 's'),
    new barrel.SchemaDecodeError('x', 't', 0, 0n),
    new barrel.EventHandlerError('x', 't', 0, 0n, 1),
    new barrel.HandlerBindingError('x'),
  ];

  it('every package error is a KafkaError', () => {
    for (const instance of instances) {
      expect(instance).toBeInstanceOf(barrel.KafkaError);
      expect(instance).toBeInstanceOf(Error);
    }
  });

  it('every package error names itself', () => {
    expect(instances.map(e => e.name)).toEqual([
      'KafkaConfigError',
      'SchemaEncodeError',
      'SchemaRegistrationError',
      'SchemaDecodeError',
      'EventHandlerError',
      'HandlerBindingError',
    ]);
  });

  it('consumer errors carry the message coordinates', () => {
    const decode = new barrel.SchemaDecodeError('x', 'topic', 3, 77n);
    expect(decode).toMatchObject({ topic: 'topic', partition: 3, offset: 77n });

    const handler = new barrel.EventHandlerError('x', 'topic', 3, 77n, 4);
    expect(handler).toMatchObject({ topic: 'topic', partition: 3, offset: 77n, attempts: 4 });
  });

  it('exposes the event scope symbol under the documented key', () => {
    expect(barrel.EVENT_SCOPE).toBe(Symbol.for('moribashi.scope.event'));
  });

  it('exposes the correlation header and DLQ header prefix', () => {
    expect(barrel.CORRELATION_ID_HEADER).toBe('x-correlation-id');
    expect(barrel.DLQ_HEADER_PREFIX).toBe('x-moribashi-dlq-');
  });

  it('names itself after its own class, not the base', () => {
    expect(new barrel.SchemaEncodeError('x', 't', 's').name).toBe('SchemaEncodeError');
    expect(new barrel.SchemaRegistrationError('x', 's').name).toBe('SchemaRegistrationError');
    expect(new barrel.KafkaConfigError('x').name).toBe('KafkaConfigError');
    expect(new barrel.KafkaError('x').name).toBe('KafkaError');
  });

  it('preserves the cause chain', () => {
    const cause = new Error('root');
    expect(new barrel.KafkaConfigError('x', { cause }).cause).toBe(cause);
  });
});
