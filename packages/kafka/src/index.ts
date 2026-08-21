export {
  type KafkaConfig,
  type KafkaConfigInput,
  type SaslConfig,
  type SaslMechanism,
  type OauthBearerSaslConfig,
  type PasswordSaslConfig,
  type SchemaRegistryConfig,
  type TlsConfig,
  type TokenProvider,
  type TopicMessageTypes,
  SASL_MECHANISMS,
  createKafkaConfig,
} from './config.js';

export {
  type KafkaClient,
  type KafkaConnectionOptions,
  buildConnectionOptions,
  createKafkaClient,
  isKafkaClient,
} from './client.js';

export {
  type SchemaRegistryClient,
  type WirePrefix,
  MAGIC_BYTE,
  createSchemaRegistry,
  readWirePrefix,
} from './registry.js';

export {
  type CheckSchemaCompatibilityOptions,
  type Logger,
  type ReadSchemasOptions,
  type RegisterSchemasOptions,
  type RegisteredSchema,
  type SchemaCompatibilityResult,
  type SchemaSource,
  SCHEMA_FILE_EXTENSION,
  checkSchemaCompatibility,
  logError,
  readSchemaSources,
  registerSchemas,
  subjectForFile,
  subjectForTopic,
} from './schemas.js';

export {
  type CreateProducerOptions,
  type KafkaProducer,
  type ProducerMessage,
  type RawProducer,
  type SendOptions,
  createProducer,
} from './producer.js';

export {
  type EventCradle,
  type EventMessage,
  type EventScope,
  CORRELATION_ID_HEADER,
  EVENT_SCOPE,
  correlationIdFrom,
} from './scope.js';

export {
  type EventHandler,
  type EventHandlerFn,
  type HandlerBinding,
  type HandlerMap,
  type ResolveHandlerBindingsOptions,
  type ResolvedHandler,
  DEFAULT_CONVENTION_PATTERN,
  isEventHandler,
  resolveHandlerBindings,
} from './handlers.js';

export {
  type ConsumerStats,
  type CreateConsumerOptions,
  type FailurePolicy,
  type KafkaConsumer,
  type RawConsumer,
  type RawDlqProducer,
  DLQ_HEADER_PREFIX,
  createConsumer,
} from './consumer.js';

export {
  type KafkaConsumerCradle,
  type KafkaConsumerPluginOptions,
  type KafkaCradle,
  type KafkaPluginOptions,
  kafkaConsumerPlugin,
  kafkaPlugin,
} from './plugin.js';

export {
  EventHandlerError,
  HandlerBindingError,
  KafkaError,
  KafkaConfigError,
  SchemaDecodeError,
  SchemaEncodeError,
  SchemaRegistrationError,
} from './errors.js';

export function diagnostics() {
  return { module: '@moribashi/kafka' };
}
