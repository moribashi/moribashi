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
    'kafkaPlugin',
  ])('exports %s as a function', name => {
    expect(typeof barrel[name as keyof typeof barrel]).toBe('function');
  });

  it.each([
    'KafkaError',
    'KafkaConfigError',
    'SchemaEncodeError',
    'SchemaRegistrationError',
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
        'SASL_MECHANISMS',
        'SCHEMA_FILE_EXTENSION',
        'KafkaConfigError',
        'KafkaError',
        'SchemaEncodeError',
        'SchemaRegistrationError',
        'buildConnectionOptions',
        'checkSchemaCompatibility',
        'createKafkaClient',
        'createKafkaConfig',
        'createProducer',
        'createSchemaRegistry',
        'diagnostics',
        'isKafkaClient',
        'kafkaPlugin',
        'readSchemaSources',
        'registerSchemas',
        'subjectForFile',
        'subjectForTopic',
      ].sort(),
    );
  });
});

describe('error taxonomy', () => {
  it('every package error is a KafkaError', () => {
    for (const Ctor of [
      barrel.KafkaConfigError,
      barrel.SchemaEncodeError,
      barrel.SchemaRegistrationError,
    ]) {
      const instance =
        Ctor === barrel.KafkaConfigError
          ? new barrel.KafkaConfigError('x')
          : Ctor === barrel.SchemaEncodeError
            ? new barrel.SchemaEncodeError('x', 't', 's')
            : new barrel.SchemaRegistrationError('x', 's');

      expect(instance).toBeInstanceOf(barrel.KafkaError);
      expect(instance).toBeInstanceOf(Error);
    }
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
