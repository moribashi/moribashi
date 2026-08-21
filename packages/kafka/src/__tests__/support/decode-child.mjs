/**
 * Consumes a topic and decodes it **in a separate process, using nothing from
 * this package**.
 *
 * That isolation is the whole point. The bug this suite exists to prevent —
 * a missing protobuf message-index array — was invisible precisely because
 * one library both wrote and read the bytes: a same-process round trip proves
 * only that a codec agrees with itself. Here the reader is
 * `@confluentinc/schemaregistry`'s stock `ProtobufDeserializer`, wired up from
 * scratch, standing in for the Java/Go/Python/C# consumers that could not read
 * the old framing. The wire prefix is parsed by hand below rather than with
 * this package's `readWirePrefix`, for the same reason.
 *
 * Usage: node decode-child.mjs '<json>' where json is
 *   { brokers: string[], registryUrl, topic, groupId, expect, timeoutMs }
 * Prints one JSON object on stdout: { messages: [{ key, hex, prefix, value }] }
 */
import { Consumer } from '@platformatic/kafka';
import {
  ProtobufDeserializer,
  SchemaRegistryClient,
  SerdeType,
  SubjectNameStrategyType,
} from '@confluentinc/schemaregistry';

const opts = JSON.parse(process.argv[2]);

/** Zig-zag varint, as Confluent writes message indexes. */
function readVarInt(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result % 2 ? -(result + 1) / 2 : result / 2, pos];
}

function readPrefix(buf) {
  const magic = buf[0];
  const schemaId = buf.readInt32BE(1);
  if (buf[5] === 0x00) return { magic, schemaId, messageIndexes: [0], length: 6 };
  let [count, pos] = readVarInt(buf, 5);
  const messageIndexes = [];
  for (let i = 0; i < count; i++) {
    const [index, next] = readVarInt(buf, pos);
    messageIndexes.push(index);
    pos = next;
  }
  return { magic, schemaId, messageIndexes, length: pos };
}

const client = new SchemaRegistryClient({ baseURLs: [opts.registryUrl] });
const deserializer = new ProtobufDeserializer(client, SerdeType.VALUE, {
  subjectNameStrategyType: SubjectNameStrategyType.TOPIC,
});

const consumer = new Consumer({
  clientId: 'moribashi-kafka-it-child',
  bootstrapBrokers: opts.brokers,
  groupId: opts.groupId,
  autocreateTopics: false,
  deserializers: {
    key: d => d,
    value: d => d,
    headerKey: d => d?.toString('utf8'),
    headerValue: d => d?.toString('utf8'),
  },
});

const messages = [];
const stream = await consumer.consume({ topics: [opts.topic], mode: 'earliest', autocommit: false });
const timer = setTimeout(() => void stream.close().catch(() => {}), opts.timeoutMs ?? 30_000);

try {
  for await (const message of stream) {
    const value = Buffer.from(message.value);
    messages.push({
      key: message.key?.length ? message.key.toString('utf8') : undefined,
      hex: value.toString('hex'),
      prefix: readPrefix(value),
      value: await deserializer.deserialize(opts.topic, value),
    });
    if (messages.length >= opts.expect) break;
  }
} finally {
  clearTimeout(timer);
  await stream.close().catch(() => {});
  await consumer.close().catch(() => {});
}

process.stdout.write(JSON.stringify({ messages }));
