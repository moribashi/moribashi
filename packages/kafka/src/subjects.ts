import path from 'node:path';

export const SCHEMA_FILE_EXTENSION = '.proto';

/**
 * Confluent's `TopicNameStrategy`: the value schema for topic `t` lives at
 * subject `t-value`. Schema files are therefore named after their subject —
 * `iam.identity.created.v1-value.proto` — and the subject is just the
 * basename. The same derivation runs on the produce side (`subjectForTopic`),
 * which is what keeps registration and encoding pointed at one subject.
 */
export function subjectForFile(file: string): string {
  return path.basename(file, SCHEMA_FILE_EXTENSION);
}

/** The value subject a message on `topic` is encoded against. */
export function subjectForTopic(topic: string): string {
  return `${topic}-value`;
}
