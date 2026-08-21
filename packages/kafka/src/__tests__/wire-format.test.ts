/**
 * The regression suite for the bug that motivated moving to
 * `@confluentinc/schemaregistry`.
 *
 * `@kafkajs/confluent-schema-registry` wrote `magic | schemaId | payload` and
 * omitted the protobuf **message-index array** the Confluent wire format
 * requires. Nothing threw: its own decoder omitted the same bytes, so a
 * producer and consumer built on it round-tripped happily while Redpanda
 * Console showed `UTF8WITHCONTROLCHARS` and every standard Confluent
 * deserializer — Java, Go, Python, C# — read garbage. That symmetry is why the
 * old suite was green, and it is why these tests assert **bytes**, not
 * round-trips.
 *
 * `MockClient` stands in for the registry so this runs with no broker; the
 * serializer and its configuration are the real ones, built by
 * `createSchemaRegistry()`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import { MockClient } from '@confluentinc/schemaregistry';
import {
  createKafkaConfig,
  createSchemaRegistry,
  readWirePrefix,
  type SchemaRegistryClient,
} from '../index.js';
import {
  TestEnvelopeSchema,
  TestEnvelope_NestedSchema,
  TestEventSchema,
} from './fixtures/test_event_pb.js';
import { baseConfig } from './helpers.js';

const EVENT_TOPIC = 'moribashi.wire.event.v1';
const ENVELOPE_TOPIC = 'moribashi.wire.envelope.v1';
const NESTED_TOPIC = 'moribashi.wire.nested.v1';

let mock: MockClient;
let registry: SchemaRegistryClient;
let schemaIds: Record<string, number>;

async function seed(topic: string): Promise<number> {
  return mock.register(`${topic}-value`, {
    schema: FILE_DESCRIPTOR_B64,
    schemaType: 'PROTOBUF',
  });
}

/** The fixture file's descriptor bytes, base64 — what the registry stores. */
const FILE_DESCRIPTOR_B64 =
  'Cihtb3JpYmFzaGkva2Fma2EvdGVzdC92MS90ZXN0X2V2ZW50LnByb3RvEhdtb3JpYmFzaGkua2Fma2EudGVzdC52MSI8CglUZXN0RXZlbnQSCgoCaWQYASABKAkSDQoFZW1haWwYAiABKAkSFAoMZGlzcGxheV9uYW1lGAMgASgJInAKDFRlc3RFbnZlbG9wZRIKCgJpZBgBIAEoCRI8CgZuZXN0ZWQYAiABKAsyLC5tb3JpYmFzaGkua2Fma2EudGVzdC52MS5UZXN0RW52ZWxvcGUuTmVzdGVkGhYKBk5lc3RlZBIMCgRub3RlGAEgASgJYgZwcm90bzM=';

beforeEach(async () => {
  mock = new MockClient();
  registry = createSchemaRegistry(
    createKafkaConfig({
      ...baseConfig,
      messages: {
        [EVENT_TOPIC]: TestEventSchema,
        [ENVELOPE_TOPIC]: TestEnvelopeSchema,
        [NESTED_TOPIC]: TestEnvelope_NestedSchema,
      },
    }),
    mock,
  );
  schemaIds = {
    [EVENT_TOPIC]: await seed(EVENT_TOPIC),
    [ENVELOPE_TOPIC]: await seed(ENVELOPE_TOPIC),
    [NESTED_TOPIC]: await seed(NESTED_TOPIC),
  };
});

describe('Confluent wire format', () => {
  it('frames a single top-level message as magic | schemaId | 0x00 | payload', async () => {
    const message = create(TestEventSchema, {
      id: 'a1',
      email: 'a@example.com',
      displayName: 'A',
    });
    const bytes = await registry.encode(EVENT_TOPIC, message);

    expect(bytes[0]).toBe(0x00); // magic
    expect(bytes.readInt32BE(1)).toBe(schemaIds[EVENT_TOPIC]); // schema id
    // *The* byte. `TestEvent` is the first top-level message in its file, so
    // its index array is `[0]`, written as the single byte 0x00.
    expect(bytes[5]).toBe(0x00);
    // What the broken client wrote here instead: the protobuf field tag for
    // field 1, length-delimited. If this ever comes back, so has the bug.
    expect(bytes[5]).not.toBe(0x0a);

    // Everything after the 6-byte prefix is the plain protobuf encoding.
    expect(bytes.subarray(6)).toEqual(Buffer.from(toBinary(TestEventSchema, message)));
    expect(bytes.length).toBe(6 + toBinary(TestEventSchema, message).length);
  });

  it('indexes a message that is not the first in its file', async () => {
    const bytes = await registry.encode(
      ENVELOPE_TOPIC,
      create(TestEnvelopeSchema, { id: 'e1' }),
    );

    // `TestEnvelope` is index 1, so the array is a real one: count 1 then
    // index 1, each a zig-zag varint — 0x02, 0x02.
    expect(bytes[0]).toBe(0x00);
    expect(bytes.readInt32BE(1)).toBe(schemaIds[ENVELOPE_TOPIC]);
    expect([...bytes.subarray(5, 7)]).toEqual([0x02, 0x02]);
    expect(readWirePrefix(bytes)).toEqual({
      magic: 0x00,
      schemaId: schemaIds[ENVELOPE_TOPIC],
      messageIndexes: [1],
      length: 7,
    });
  });

  it('indexes a nested message by its full path', async () => {
    const bytes = await registry.encode(
      NESTED_TOPIC,
      create(TestEnvelope_NestedSchema, { note: 'n' }),
    );

    // `TestEnvelope.Nested` is nested message 0 of top-level message 1, so the
    // array is [1, 0]: count 2 (0x04), then 0x02, 0x00.
    expect([...bytes.subarray(5, 8)]).toEqual([0x04, 0x02, 0x00]);
    expect(readWirePrefix(bytes)).toEqual({
      magic: 0x00,
      schemaId: schemaIds[NESTED_TOPIC],
      messageIndexes: [1, 0],
      length: 8,
    });
  });

  it('round-trips through the standard decoder', async () => {
    const message = create(TestEventSchema, {
      id: 'a1',
      email: 'a@example.com',
      displayName: 'A',
    });
    const bytes = await registry.encode(EVENT_TOPIC, message);

    expect(await registry.decode(EVENT_TOPIC, bytes)).toEqual(message);
  });

  it('decodes a nested message the index array points at', async () => {
    const message = create(TestEnvelope_NestedSchema, { note: 'n' });
    const bytes = await registry.encode(NESTED_TOPIC, message);

    expect(await registry.decode(NESTED_TOPIC, bytes)).toEqual(message);
  });

  it('decodes a message-typed field — the registry descriptor is repaired first', async () => {
    const message = create(TestEnvelopeSchema, { id: 'e1', nested: { note: 'n' } });
    const bytes = await registry.encode(ENVELOPE_TOPIC, message);

    // Registry descriptors name a field's type without saying whether it is a
    // message or an enum. Unrepaired, `nested` links as a scalar and comes
    // back as a NaN double.
    expect(await registry.decode(ENVELOPE_TOPIC, bytes)).toEqual(message);
  });
});

describe('the framing the old client produced', () => {
  /**
   * Twelve real bytes off `iam.identity.created.v1` in production, written by
   * `@kafkajs/confluent-schema-registry`: magic and schema id are right, and
   * then the protobuf payload starts immediately at byte 5.
   */
  const PRODUCTION_BAD_BYTES = Buffer.from('0000000008' + '0a2466626531377878', 'hex');

  it('is rejected by the prefix reader instead of being read as indexes', () => {
    expect(PRODUCTION_BAD_BYTES[0]).toBe(0x00);
    expect(PRODUCTION_BAD_BYTES.readInt32BE(1)).toBe(8);
    expect(PRODUCTION_BAD_BYTES[5]).toBe(0x0a);

    expect(() => readWirePrefix(PRODUCTION_BAD_BYTES)).toThrow(/malformed/);
  });

  it('does not survive the standard decoder', async () => {
    const message = create(TestEventSchema, { id: 'a1', email: 'a@example.com' });
    const idBytes = Buffer.alloc(4);
    idBytes.writeInt32BE(schemaIds[EVENT_TOPIC]!);
    // Exactly what the old library wrote: no message-index array at all.
    const unframed = Buffer.concat([
      Buffer.from([0x00]),
      idBytes,
      Buffer.from(toBinary(TestEventSchema, message)),
    ]);

    await expect(registry.decode(EVENT_TOPIC, unframed)).rejects.toBeTruthy();
  });
});

describe('boot-time registration is still the only registration', () => {
  it('refuses to encode for a subject nobody registered', async () => {
    const before = await mock.getAllSubjects();

    await expect(
      registry.encode('moribashi.wire.unregistered.v1', create(TestEventSchema, { id: 'x' })),
    ).rejects.toBeTruthy();

    // The serializer runs with `autoRegisterSchemas: false`, so a send against
    // an unknown subject fails instead of quietly creating it — which is what
    // keeps an incompatible contract a boot failure rather than a failure on
    // the first produce, inside the token-mint path.
    expect(await mock.getAllSubjects()).toEqual(before);
  });
});
