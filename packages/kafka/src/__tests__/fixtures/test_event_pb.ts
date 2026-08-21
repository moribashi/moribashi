// Shaped exactly as `protoc-gen-es` (target=ts) emits a generated file, and
// used as one: the wire-format and integration suites feed `TestEventSchema`
// straight to the serializer, which is the path a real service takes with its
// Buf-generated types.
//
// It is hand-checked in rather than generated at test time so the suite needs
// no `buf`/`protoc` toolchain. The `.proto` it corresponds to is `TEST_PROTO`
// below — the integration suite registers *that* text, so the two must be kept
// in step. Regenerate with `buf generate`, or by round-tripping the source
// through a schema registry and taking `?format=serialized`.
//
// @generated from file moribashi/kafka/test/v1/test_event.proto (package moribashi.kafka.test.v1, syntax proto3)
/* eslint-disable */

import type { Message } from '@bufbuild/protobuf';
import { fileDesc, messageDesc, type GenFile, type GenMessage } from '@bufbuild/protobuf/codegenv2';

/** The `.proto` source this file was generated from. */
export const TEST_PROTO = `syntax = "proto3";

package moribashi.kafka.test.v1;

message TestEvent {
  string id = 1;
  string email = 2;
  string display_name = 3;
}

message TestEnvelope {
  message Nested {
    string note = 1;
  }

  string id = 1;
  Nested nested = 2;
}
`;

/**
 * Describes the file `moribashi/kafka/test/v1/test_event.proto`.
 */
export const file_moribashi_kafka_test_v1_test_event: GenFile = /*@__PURE__*/
  fileDesc(
    'Cihtb3JpYmFzaGkva2Fma2EvdGVzdC92MS90ZXN0X2V2ZW50LnByb3RvEhdtb3JpYmFzaGkua2Fma2EudGVzdC52MSI8CglUZXN0RXZlbnQSCgoCaWQYASABKAkSDQoFZW1haWwYAiABKAkSFAoMZGlzcGxheV9uYW1lGAMgASgJInAKDFRlc3RFbnZlbG9wZRIKCgJpZBgBIAEoCRI8CgZuZXN0ZWQYAiABKAsyLC5tb3JpYmFzaGkua2Fma2EudGVzdC52MS5UZXN0RW52ZWxvcGUuTmVzdGVkGhYKBk5lc3RlZBIMCgRub3RlGAEgASgJYgZwcm90bzM=',
  );

/**
 * @generated from message moribashi.kafka.test.v1.TestEvent
 */
export type TestEvent = Message<'moribashi.kafka.test.v1.TestEvent'> & {
  /** @generated from field: string id = 1; */
  id: string;
  /** @generated from field: string email = 2; */
  email: string;
  /** @generated from field: string display_name = 3; */
  displayName: string;
};

/**
 * Describes the message moribashi.kafka.test.v1.TestEvent.
 * Use `create(TestEventSchema)` to create a new message.
 */
export const TestEventSchema: GenMessage<TestEvent> = /*@__PURE__*/
  messageDesc(file_moribashi_kafka_test_v1_test_event, 0);

/**
 * @generated from message moribashi.kafka.test.v1.TestEnvelope
 */
export type TestEnvelope = Message<'moribashi.kafka.test.v1.TestEnvelope'> & {
  /** @generated from field: string id = 1; */
  id: string;
  /** @generated from field: moribashi.kafka.test.v1.TestEnvelope.Nested nested = 2; */
  nested?: TestEnvelope_Nested;
};

/**
 * Describes the message moribashi.kafka.test.v1.TestEnvelope.
 * Use `create(TestEnvelopeSchema)` to create a new message.
 */
export const TestEnvelopeSchema: GenMessage<TestEnvelope> = /*@__PURE__*/
  messageDesc(file_moribashi_kafka_test_v1_test_event, 1);

/**
 * @generated from message moribashi.kafka.test.v1.TestEnvelope.Nested
 */
export type TestEnvelope_Nested = Message<'moribashi.kafka.test.v1.TestEnvelope.Nested'> & {
  /** @generated from field: string note = 1; */
  note: string;
};

/**
 * Describes the message moribashi.kafka.test.v1.TestEnvelope.Nested.
 * Use `create(TestEnvelope_NestedSchema)` to create a new message.
 */
export const TestEnvelope_NestedSchema: GenMessage<TestEnvelope_Nested> = /*@__PURE__*/
  messageDesc(file_moribashi_kafka_test_v1_test_event, 1, 0);
