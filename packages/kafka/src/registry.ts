import {
  create,
  createMutableRegistry,
  type DescFile,
  type Message,
} from '@bufbuild/protobuf';
import {
  ProtobufDeserializer,
  ProtobufSerializer,
  SchemaRegistryClient as ConfluentRegistryClient,
  SerdeType,
  SubjectNameStrategyType,
  type Client as ConfluentClient,
  type ClientConfig as ConfluentClientConfig,
  type SchemaInfo,
} from '@confluentinc/schemaregistry';
import type { KafkaConfig, TopicMessageTypes } from './config.js';
import { repairDescriptorSet } from './descriptors.js';
import { SchemaEncodeError } from './errors.js';
import { subjectForTopic } from './subjects.js';

/**
 * The Confluent wire format, in full:
 *
 * ```
 * magic (0x00) | schema id (int32 BE) | message-index array | payload
 * ```
 *
 * The message-index array is the part `@kafkajs/confluent-schema-registry`
 * omitted, and the reason this package moved to Confluent's own client. It is
 * a zig-zag varint count followed by that many zig-zag varint indexes, naming
 * the path to the message *within* its `.proto` file — except for the
 * overwhelmingly common `[0]` (the first top-level message), which is encoded
 * as the single byte `0x00`.
 *
 * Without it a standard Confluent deserializer reads the first byte of the
 * protobuf payload as the index count. For `[0]`-shaped messages that byte is
 * a field tag (`0x0a` for field 1, length-delimited), which zig-zag decodes to
 * `5` — so the reader consumes five more bytes as indexes and hands the rest
 * to protobuf as garbage. Nothing throws; the bytes are simply wrong. Only a
 * decoder with the identical omission can read them back, which is exactly why
 * a symmetric producer/consumer test suite stayed green while Redpanda Console
 * and every Java/Go/Python consumer saw nonsense.
 */
export const MAGIC_BYTE = 0x00;

/** The framing that precedes the protobuf payload, decoded. */
export interface WirePrefix {
  /** Always `0x00` for a schema-id (v0) frame. */
  magic: number;
  /** Registry-assigned schema id, big-endian int32. */
  schemaId: number;
  /** Path to the message within its file — `[0]` for a single top-level one. */
  messageIndexes: number[];
  /** Total prefix length in bytes; the payload starts here. */
  length: number;
}

function readZigZagVarInt(buffer: Buffer, start: number): [value: number, next: number] {
  let result = 0;
  let shift = 0;
  let pos = start;
  for (;;) {
    if (pos >= buffer.length) {
      throw new RangeError('truncated varint in Confluent wire prefix');
    }
    const byte = buffer[pos]!;
    pos += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new RangeError('overlong varint in Confluent wire prefix');
  }
  // Zig-zag: the low bit is the sign.
  const value = result % 2 ? -(result + 1) / 2 : result / 2;
  return [value, pos];
}

/**
 * Parses the Confluent framing off the front of a message value.
 *
 * Exported because this package got the framing wrong once and shipped it: a
 * caller (or a test) that wants to *prove* what went on the wire should not
 * have to hand-roll varint reading to do it.
 *
 * Throws `RangeError` when the bytes are not a well-formed v0 protobuf frame.
 */
export function readWirePrefix(payload: Buffer): WirePrefix {
  if (payload.length < 6) {
    throw new RangeError(
      `Confluent frame is ${payload.length} bytes — too short to hold magic, schema id and a message-index array.`,
    );
  }
  const magic = payload[0]!;
  if (magic !== MAGIC_BYTE) {
    throw new RangeError(
      `expected magic byte 0x00, got 0x${magic.toString(16).padStart(2, '0')}`,
    );
  }
  const schemaId = payload.readInt32BE(1);

  // The single byte `0x00` is the shorthand for `[0]`, not "zero indexes".
  if (payload[5] === 0x00) {
    return { magic, schemaId, messageIndexes: [0], length: 6 };
  }

  let [count, pos] = readZigZagVarInt(payload, 5);
  if (count < 0) {
    throw new RangeError(
      `message-index count decoded to ${count} — the index array is absent or malformed`,
    );
  }
  const messageIndexes: number[] = [];
  for (let i = 0; i < count; i++) {
    const [index, next] = readZigZagVarInt(payload, pos);
    if (index < 0) {
      throw new RangeError(`message index ${index} is negative — the index array is malformed`);
    }
    messageIndexes.push(index);
    pos = next;
  }
  return { magic, schemaId, messageIndexes, length: pos };
}

/**
 * The Schema Registry surface this package uses, narrowed to four operations.
 *
 * Keeping it narrow is what lets tests fake a registry without standing one
 * up, and it documents exactly how much of `@confluentinc/schemaregistry` we
 * depend on. Note that `encode`/`decode` are **topic-scoped**: Confluent's
 * serde derives the subject from the topic (`TopicNameStrategy`) rather than
 * taking a pre-resolved schema id.
 */
export interface SchemaRegistryClient {
  /** Registers a `.proto` source under `subject`; returns the schema id. */
  register(subject: string, schema: string): Promise<number>;
  /** The id of the subject's latest version. */
  getLatestSchemaId(subject: string): Promise<number>;
  /** Confluent-framed bytes for `value` on `topic`. */
  encode(topic: string, value: unknown): Promise<Buffer>;
  /** Decodes Confluent-framed bytes read from `topic`. */
  decode(topic: string, payload: Buffer): Promise<unknown>;
  /** Drops every cached subject/id/schema lookup. */
  clearCaches(): void;
}

const PROTOBUF = 'PROTOBUF';
const SERIALIZED = 'serialized';

/**
 * `ProtobufDeserializer`, with registry descriptors repaired before they are
 * linked.
 *
 * Redpanda hands back `?format=serialized` descriptors whose message- and
 * enum-typed fields carry only `type_name`; `@bufbuild/protobuf` does not
 * infer the missing `type` and silently treats them as scalars. See
 * `descriptors.ts`. The repair has to land before `createFileRegistry()` runs
 * inside the library, so it hooks the two public methods that hand it its
 * inputs: `toFileDesc` for the schema being decoded, and `resolveReferences`
 * for every schema it imports.
 */
class RepairingProtobufDeserializer extends ProtobufDeserializer {
  /** Repaired dependencies, keyed by import name, awaiting `resolveReferences`. */
  readonly #repairedDeps = new Map<string, string>();

  override async toFileDesc(client: ConfluentClient, info: SchemaInfo): Promise<DescFile> {
    // Fetch the references first (the client caches them, so the second
    // fetch inside `super` is free) — a field's type may be declared in an
    // imported file, so the whole set has to be resolvable at once.
    const raw = new Map<string, string>();
    await super.resolveReferences(client, info, raw, SERIALIZED);

    const { main, deps } = repairDescriptorSet(info.schema, raw);
    for (const [name, schema] of deps) this.#repairedDeps.set(name, schema);

    return super.toFileDesc(client, { ...info, schema: main });
  }

  override async resolveReferences(
    client: ConfluentClient,
    schema: SchemaInfo,
    deps: Map<string, string>,
    format?: string,
  ): Promise<void> {
    await super.resolveReferences(client, schema, deps, format);
    for (const name of deps.keys()) {
      const repaired = this.#repairedDeps.get(name);
      if (repaired !== undefined) deps.set(name, repaired);
    }
  }
}

/** Milliseconds → whole seconds, which is the unit Confluent's client takes. */
function toTtlSecs(ms: number | undefined): number | undefined {
  if (ms === undefined) return undefined;
  // `0` disables our cache; Confluent reads `-1` as "never expire" and `0` as
  // "expire immediately", so `0` is passed through unchanged.
  return Math.max(0, Math.round(ms / 1000));
}

function basicAuth(config: KafkaConfig): ConfluentClientConfig['basicAuthCredentials'] {
  const auth = config.schemaRegistry.auth;
  if (!auth) return undefined;
  return { credentialsSource: 'USER_INFO', userInfo: `${auth.username}:${auth.password}` };
}

/**
 * Builds the registry client, the protobuf serializer and the protobuf
 * deserializer, and adapts them to this package's four-method seam.
 *
 * Serializer configuration is deliberate on two points:
 *
 * - **`autoRegisterSchemas: false`.** Confluent's serializer will happily
 *   register a subject on the first send. That would move an incompatible
 *   contract from "the pod crashloops at boot" to "the first produce fails" —
 *   which, in svc-iam, is inside Keycloak's token-mint path. Registration
 *   stays where `registerSchemas()` puts it: plugin `register()`, awaited by
 *   `app.start()` before the port binds.
 * - **`useLatestVersion: true`.** The id comes from a lookup of the subject's
 *   latest version, exactly as the old producer's `getLatestSchemaId()` did,
 *   rather than from posting the locally-derived schema back to the registry.
 */
export function createSchemaRegistry(
  config: KafkaConfig,
  /**
   * BYO `@confluentinc/schemaregistry` client — the seam the wire-format suite
   * uses to exercise the real serializer against `MockClient` instead of a
   * live registry. Everything above this line stays the same either way, which
   * is the point: the framing under test is the framing that ships.
   */
  registryClient?: ConfluentClient,
): SchemaRegistryClient {
  const auth = basicAuth(config);
  const cacheLatestTtlSecs = toTtlSecs(config.schemaCacheTtlMs);

  const client: ConfluentClient =
    registryClient ??
    new ConfluentRegistryClient({
      baseURLs: [config.schemaRegistry.url],
      ...(auth ? { basicAuthCredentials: auth } : {}),
      ...(cacheLatestTtlSecs !== undefined ? { cacheLatestTtlSecs } : {}),
      createAxiosDefaults: { headers: { 'X-Client-Id': config.clientId } },
    } satisfies ConfluentClientConfig);

  const messageTypes: TopicMessageTypes = config.messages ?? {};
  const subjectFor = config.subjectFor ?? subjectForTopic;

  // Seeded with every declared message type, because the serializer resolves
  // a message's descriptor by `$typeName` out of this registry. Only the
  // top-level descriptors are needed: nested and imported types are reachable
  // through the descriptor itself, not through a lookup.
  const descriptors = createMutableRegistry(...Object.values(messageTypes));

  // `TopicNameStrategy` is pinned explicitly rather than left to the client's
  // default (`ASSOCIATED`, which asks the registry about associations): it is
  // the strategy `subjectForTopic()` and `subjectForFile()` already encode, so
  // registration and encoding stay pointed at one subject. A custom
  // `subjectFor` replaces it for both directions at once — and must replace
  // the *type*, since a supplied type wins over a supplied function.
  const serdeConfig: {
    subjectNameStrategyType?: SubjectNameStrategyType;
    subjectNameStrategy?: (topic: string) => string;
  } = config.subjectFor
    ? { subjectNameStrategy: (topic: string) => subjectFor(topic) }
    : { subjectNameStrategyType: SubjectNameStrategyType.TOPIC };

  const serializer = new ProtobufSerializer(client, SerdeType.VALUE, {
    ...serdeConfig,
    autoRegisterSchemas: false,
    useLatestVersion: true,
    registry: descriptors,
  });

  const deserializer = new RepairingProtobufDeserializer(client, SerdeType.VALUE, {
    ...serdeConfig,
  });

  /**
   * Turns whatever a caller passed as `value` into a `@bufbuild/protobuf`
   * message the serializer can encode.
   *
   * A generated message instance is used as-is — that is the intended path,
   * and the one that makes a divergence from the `.proto` a compile error.
   * A plain object is initialised into the topic's declared message type, so
   * the pre-0.5 call style keeps working; note that `create()` takes field
   * names in their generated (camelCase) form.
   */
  function toMessage(topic: string, value: unknown): Message {
    const declared = messageTypes[topic];
    const typeName =
      typeof value === 'object' && value !== null
        ? (value as Partial<Message>).$typeName
        : undefined;

    if (typeName !== undefined) {
      if (declared && declared.typeName !== typeName) {
        throw new SchemaEncodeError(
          `Topic "${topic}" is declared as "${declared.typeName}" but the message is ` +
            `"${typeName}". Producing the wrong event type to a topic is a contract break, ` +
            'not a coincidence — check the `messages` map.',
          topic,
          subjectFor(topic),
        );
      }
      if (!declared && descriptors.getMessage(typeName) === undefined) {
        throw new SchemaEncodeError(
          `No descriptor registered for message type "${typeName}". Declare the topic in ` +
            "`messages`, e.g. `messages: { '" +
            topic +
            "': IdentityCreatedSchema }`.",
          topic,
          subjectFor(topic),
        );
      }
      return value as Message;
    }

    if (!declared) {
      throw new SchemaEncodeError(
        `No message type declared for topic "${topic}". Pass a Buf-generated message, or ` +
          "declare the topic, e.g. `messages: { '" +
          topic +
          "': IdentityCreatedSchema }`.",
        topic,
        subjectFor(topic),
      );
    }

    try {
      return create(declared, value as never);
    } catch (cause) {
      throw new SchemaEncodeError(
        `Value for topic "${topic}" is not a valid "${declared.typeName}": ` +
          `${(cause as Error).message}`,
        topic,
        subjectFor(topic),
        undefined,
        { cause },
      );
    }
  }

  return {
    async register(subject, schema) {
      return client.register(subject, { schema, schemaType: PROTOBUF }, false);
    },

    async getLatestSchemaId(subject) {
      const metadata = await client.getLatestSchemaMetadata(subject);
      if (typeof metadata.id !== 'number') {
        throw new Error(`registry returned no schema id for subject "${subject}"`);
      }
      return metadata.id;
    },

    async encode(topic, value) {
      return serializer.serialize(topic, toMessage(topic, value));
    },

    async decode(topic, payload) {
      return deserializer.deserialize(topic, payload);
    },

    clearCaches() {
      client.clearCaches();
    },
  };
}
