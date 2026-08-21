import { fromBinary, toBinary, type DescEnum, type DescFile, type DescMessage } from '@bufbuild/protobuf';
import {
  FieldDescriptorProto_Type,
  FileDescriptorProtoSchema,
  file_google_protobuf_any,
  file_google_protobuf_api,
  file_google_protobuf_descriptor,
  file_google_protobuf_duration,
  file_google_protobuf_empty,
  file_google_protobuf_field_mask,
  file_google_protobuf_source_context,
  file_google_protobuf_struct,
  file_google_protobuf_timestamp,
  file_google_protobuf_type,
  file_google_protobuf_wrappers,
  type DescriptorProto,
  type FieldDescriptorProto,
  type FileDescriptorProto,
} from '@bufbuild/protobuf/wkt';

/**
 * Repairs `FileDescriptorProto`s fetched from a Schema Registry.
 *
 * Redpanda's registry (and it is not alone) returns `?format=serialized`
 * descriptors in which a message- or enum-typed field carries only
 * `type_name` — the `type` enum that says *which of the two it is* is left
 * unset, on the assumption the reader will infer it while linking. `protoc`
 * does infer it; `@bufbuild/protobuf`'s `createFileRegistry()` does not. It
 * treats the field as a scalar of type 0, and then silently encodes and
 * decodes garbage for it: a nested message comes back as a NaN double, an
 * enum as nothing at all.
 *
 * That matters here because a consumer decodes from the registry's descriptor
 * and has no local `.proto` to fall back on. The previous library parsed
 * `.proto` *source* with protobufjs, which resolved types itself, so this only
 * became a problem on the move to descriptor-based decoding — and it is the
 * same shape of failure as the framing bug that motivated the move: no error,
 * just wrong bytes.
 *
 * Anything that cannot be resolved throws rather than being left to decode
 * wrongly. On the consumer that surfaces as a `SchemaDecodeError` and goes
 * through the failure policy, which is the whole point.
 */

/** Fully-qualified type name → whether it names a message or an enum. */
export type TypeKinds = Map<string, 'message' | 'enum'>;

function collectFromMessage(msg: DescriptorProto, scope: string, kinds: TypeKinds): void {
  const self = `${scope}.${msg.name}`;
  kinds.set(self, 'message');
  for (const nested of msg.enumType) kinds.set(`${self}.${nested.name}`, 'enum');
  for (const nested of msg.nestedType) collectFromMessage(nested, self, kinds);
}

function collectFromDesc(
  messages: readonly DescMessage[],
  enums: readonly DescEnum[],
  kinds: TypeKinds,
): void {
  for (const e of enums) kinds.set(`.${e.typeName}`, 'enum');
  for (const m of messages) {
    kinds.set(`.${m.typeName}`, 'message');
    collectFromDesc(m.nestedMessages, m.nestedEnums, kinds);
  }
}

/**
 * The well-known types, which are linked into every protobuf runtime rather
 * than fetched from the registry — so a schema that imports
 * `google/protobuf/timestamp.proto` names them without the registry ever
 * shipping their descriptors as references.
 */
const WELL_KNOWN_FILES: readonly DescFile[] = [
  file_google_protobuf_any,
  file_google_protobuf_api,
  file_google_protobuf_descriptor,
  file_google_protobuf_duration,
  file_google_protobuf_empty,
  file_google_protobuf_field_mask,
  file_google_protobuf_source_context,
  file_google_protobuf_struct,
  file_google_protobuf_timestamp,
  file_google_protobuf_type,
  file_google_protobuf_wrappers,
];

let wellKnownKinds: TypeKinds | undefined;

function knownWellKnownTypes(): TypeKinds {
  if (wellKnownKinds === undefined) {
    wellKnownKinds = new Map();
    for (const file of WELL_KNOWN_FILES) {
      collectFromDesc(file.messages, file.enums, wellKnownKinds);
    }
  }
  return wellKnownKinds;
}

/** Indexes every message and enum a set of files declares, by full name. */
export function collectTypeKinds(files: Iterable<FileDescriptorProto>): TypeKinds {
  const kinds: TypeKinds = new Map(knownWellKnownTypes());
  for (const file of files) {
    const scope = file.package ? `.${file.package}` : '';
    for (const e of file.enumType) kinds.set(`${scope}.${e.name}`, 'enum');
    for (const m of file.messageType) collectFromMessage(m, scope, kinds);
  }
  return kinds;
}

/**
 * `descriptor.proto`: *"If type_name is set, this need not be set. If both
 * this and type_name are set, this must be one of TYPE_ENUM, TYPE_MESSAGE or
 * TYPE_GROUP."* So a field naming a type but carrying any other `type` has an
 * unset one — and `@bufbuild/protobuf` reads an unset proto2 optional enum as
 * its first declared value, which for this enum is `TYPE_DOUBLE`. That is
 * exactly how a nested message ends up decoding as a NaN double.
 */
const RESOLVED_TYPES: ReadonlySet<FieldDescriptorProto_Type> = new Set([
  FieldDescriptorProto_Type.MESSAGE,
  FieldDescriptorProto_Type.ENUM,
  FieldDescriptorProto_Type.GROUP,
]);

function repairField(field: FieldDescriptorProto, kinds: TypeKinds, where: string): void {
  if (!field.typeName || RESOLVED_TYPES.has(field.type)) return;
  const name = field.typeName.startsWith('.') ? field.typeName : `.${field.typeName}`;
  const kind = kinds.get(name);
  if (kind === undefined) {
    throw new Error(
      `cannot resolve type "${field.typeName}" of field "${where}.${field.name}": the registry ` +
        'descriptor names it but does not say whether it is a message or an enum, and it is ' +
        'not declared in this schema or its references',
    );
  }
  field.type =
    kind === 'enum' ? FieldDescriptorProto_Type.ENUM : FieldDescriptorProto_Type.MESSAGE;
}

function repairMessage(msg: DescriptorProto, scope: string, kinds: TypeKinds): void {
  const self = `${scope}.${msg.name}`;
  for (const field of msg.field) repairField(field, kinds, self);
  for (const ext of msg.extension) repairField(ext, kinds, self);
  for (const nested of msg.nestedType) repairMessage(nested, self, kinds);
}

/** Fills in every field's missing `type`, in place. */
export function repairFileDescriptor(file: FileDescriptorProto, kinds: TypeKinds): void {
  const scope = file.package ? `.${file.package}` : '';
  for (const m of file.messageType) repairMessage(m, scope, kinds);
  for (const ext of file.extension) repairField(ext, kinds, scope || '<root>');
}

export const parseFileDescriptor = (b64: string): FileDescriptorProto =>
  fromBinary(FileDescriptorProtoSchema, Buffer.from(b64, 'base64'));

export const serializeFileDescriptor = (file: FileDescriptorProto): string =>
  Buffer.from(toBinary(FileDescriptorProtoSchema, file)).toString('base64');

/**
 * Repairs a base64 `FileDescriptorProto` and every dependency alongside it,
 * resolving type kinds across the whole set. Returns the repaired main file
 * and a map of repaired dependencies, both base64.
 */
export function repairDescriptorSet(
  mainB64: string,
  deps: ReadonlyMap<string, string>,
): { main: string; deps: Map<string, string> } {
  const main = parseFileDescriptor(mainB64);
  const parsedDeps = new Map<string, FileDescriptorProto>();
  for (const [name, b64] of deps) parsedDeps.set(name, parseFileDescriptor(b64));

  const kinds = collectTypeKinds([main, ...parsedDeps.values()]);

  repairFileDescriptor(main, kinds);
  const repairedDeps = new Map<string, string>();
  for (const [name, file] of parsedDeps) {
    repairFileDescriptor(file, kinds);
    repairedDeps.set(name, serializeFileDescriptor(file));
  }

  return { main: serializeFileDescriptor(main), deps: repairedDeps };
}
