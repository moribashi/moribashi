import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SchemaType } from '@kafkajs/confluent-schema-registry';
import { createKafkaClient, type KafkaClient, type SchemaRegistryClient } from './client.js';
import type { KafkaConfigInput } from './config.js';
import { SchemaRegistrationError } from './errors.js';

export interface Logger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  /** Optional — callers that omit it get failures on `warn` instead. */
  error?(obj: Record<string, unknown>, msg: string): void;
}

/** Logs at error level, falling back to `warn` for loggers without one. */
export function logError(log: Logger, obj: Record<string, unknown>, msg: string): void {
  (log.error ?? log.warn).call(log, obj, msg);
}

const defaultLogger: Logger = {
  warn(obj, msg) {
    console.warn(`[@moribashi/kafka] ${msg}`, obj);
  },
  info() {},
};

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

export interface RegisteredSchema {
  subject: string;
  /** The registry-assigned schema id — unchanged when nothing changed. */
  id: number;
  /** Basename of the `.proto` file the subject came from. */
  file: string;
}

export interface SchemaSource {
  file: string;
  subject: string;
  schema: string;
}

export interface ReadSchemasOptions {
  dir: string;
  subjectFor?: (file: string) => string;
  log?: Logger;
}

/**
 * Reads the `.proto` files in `dir`, sorted by filename.
 *
 * A missing directory is **not** an error: a service that produces nothing
 * has no schemas to declare. It warns and returns `[]` so the app still
 * starts. Anything else (permissions, a file that is a directory, …) throws.
 */
export async function readSchemaSources(
  opts: ReadSchemasOptions,
): Promise<SchemaSource[]> {
  const { dir, subjectFor = subjectForFile, log = defaultLogger } = opts;

  let files: string[];
  try {
    files = (await readdir(dir)).filter(f => f.endsWith(SCHEMA_FILE_EXTENSION)).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      log.warn({ dir }, 'schemas directory not found — no schemas registered');
      return [];
    }
    throw err;
  }

  if (files.length === 0) {
    log.warn({ dir }, `no ${SCHEMA_FILE_EXTENSION} files found — no schemas registered`);
    return [];
  }

  return Promise.all(
    files.map(async file => ({
      file,
      subject: subjectFor(file),
      // Strip a BOM: protobufjs's parser chokes on it, and editors add it.
      schema: (await readFile(path.join(dir, file), 'utf8')).replace(/^\uFEFF/, ''),
    })),
  );
}

export interface RegisterSchemasOptions {
  /** Defaults to the client's `schemasDir`. */
  dir?: string;
  /** BYO registry client. Defaults to the client's. */
  registry?: SchemaRegistryClient;
  /** BYO client, or config overrides used to build one. */
  client?: KafkaClient | KafkaConfigInput;
  subjectFor?: (file: string) => string;
  log?: Logger;
}

/**
 * Registers every `.proto` file in the schemas directory with the Schema
 * Registry. Runs during plugin `register()`, i.e. before the app finishes
 * starting, so a rejected contract crashloops the pod instead of shipping.
 *
 * This has the *ergonomics* of `SqlMigrationSource` — a directory of files in
 * the service repo, processed at boot — but deliberately none of its
 * machinery. There are no version prefixes, no ordering, no local ledger and
 * no `down`, because registration is declarative and idempotent: you post the
 * schema you currently want for a subject, and the registry either hands back
 * the existing id unchanged or rejects the change as incompatible. **The
 * registry is the ledger**, which is why drift is impossible and why no local
 * state is needed.
 *
 * Only call this from a service that *owns* the subjects. A consumer
 * registering a schema is a service asserting a contract it does not own.
 */
export async function registerSchemas(
  opts: RegisterSchemasOptions = {},
): Promise<RegisteredSchema[]> {
  const client = createKafkaClient(opts.client);
  const registry = opts.registry ?? client.registry;
  const dir = opts.dir ?? client.config.schemasDir;
  const log = opts.log ?? defaultLogger;

  const sources = await readSchemaSources({ dir, subjectFor: opts.subjectFor, log });

  const registered: RegisteredSchema[] = [];
  for (const { file, subject, schema } of sources) {
    try {
      const { id } = await registry.register(
        { type: SchemaType.PROTOBUF, schema },
        { subject },
      );
      registered.push({ subject, id, file });
    } catch (cause) {
      throw new SchemaRegistrationError(
        `Failed to register schema for subject "${subject}" from ${file}: ` +
          `${(cause as Error).message}`,
        subject,
        file,
        { cause },
      );
    }
  }

  if (registered.length > 0) {
    log.info({ dir, subjects: registered.map(r => r.subject) }, 'Registered schemas');
  }

  return registered;
}

// ---------------------------------------------------------------------------
// Compatibility check — the CI seam
// ---------------------------------------------------------------------------

export interface SchemaCompatibilityResult {
  subject: string;
  file: string;
  compatible: boolean;
  /** Registry-supplied explanations when incompatible (`verbose=true`). */
  messages: string[];
  /** True when the subject has no versions yet, so nothing can conflict. */
  newSubject: boolean;
}

export interface CheckSchemaCompatibilityOptions extends RegisterSchemasOptions {
  /** Subject version to check against. Defaults to `latest`. */
  version?: number | 'latest';
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/**
 * Checks each local `.proto` against the registry's compatibility policy
 * *without* registering anything.
 *
 * Kept separate from `registerSchemas()` on purpose: the same check that
 * would crashloop a pod at boot should be runnable from CI against a
 * reachable registry, so an incompatible contract change fails a PR instead.
 * That isn't wired up today (the registry is in-cluster only) — the point is
 * that it needs no new code when it is.
 *
 * Returns a report rather than throwing on incompatibility; the caller
 * decides what an incompatible subject means. Transport and registry errors
 * still throw.
 */
export async function checkSchemaCompatibility(
  opts: CheckSchemaCompatibilityOptions = {},
): Promise<SchemaCompatibilityResult[]> {
  const client = createKafkaClient(opts.client);
  const dir = opts.dir ?? client.config.schemasDir;
  const version = opts.version ?? 'latest';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { url, auth } = client.config.schemaRegistry;

  const sources = await readSchemaSources({
    dir,
    subjectFor: opts.subjectFor,
    log: opts.log ?? defaultLogger,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/vnd.schemaregistry.v1+json',
    accept: 'application/vnd.schemaregistry.v1+json',
  };
  if (auth) {
    headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  }

  const results: SchemaCompatibilityResult[] = [];
  for (const { file, subject, schema } of sources) {
    const endpoint =
      `${url.replace(/\/+$/, '')}/compatibility/subjects/` +
      `${encodeURIComponent(subject)}/versions/${version}?verbose=true`;

    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ schemaType: 'PROTOBUF', schema }),
    });

    // 404 means the subject (or its version) does not exist yet — a brand new
    // contract, which nothing can be incompatible with.
    if (res.status === 404) {
      results.push({ subject, file, compatible: true, messages: [], newSubject: true });
      continue;
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new SchemaRegistrationError(
        `Compatibility check for subject "${subject}" failed: HTTP ${res.status}` +
          `${detail ? ` — ${detail}` : ''}`,
        subject,
        file,
      );
    }

    const body = (await res.json()) as { is_compatible?: boolean; messages?: string[] };
    results.push({
      subject,
      file,
      compatible: body.is_compatible === true,
      messages: body.messages ?? [],
      newSubject: false,
    });
  }

  return results;
}
