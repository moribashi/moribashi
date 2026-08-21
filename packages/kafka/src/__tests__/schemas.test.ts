import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  checkSchemaCompatibility,
  readSchemaSources,
  registerSchemas,
  SchemaRegistrationError,
  subjectForFile,
  subjectForTopic,
  type Logger,
} from '../index.js';
import { baseConfig, clearKafkaEnv, fakeClient, fakeFetch, fakeRegistry } from './helpers.js';

const IDENTITY_PROTO = `syntax = "proto3";
package iam;
message IdentityCreated {
  string id = 1;
  string email = 2;
}
`;

let tmpDir: string;
const log: Logger & { warnings: string[]; infos: string[] } = {
  warnings: [],
  infos: [],
  warn(_obj, msg) {
    this.warnings.push(msg);
  },
  info(_obj, msg) {
    this.infos.push(msg);
  },
};

const savedEnv = { ...process.env };

beforeEach(async () => {
  clearKafkaEnv();
  log.warnings = [];
  log.infos = [];
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kafka-schemas-'));
});

afterEach(async () => {
  process.env = { ...savedEnv };
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeProto(name: string, content = IDENTITY_PROTO) {
  await fs.writeFile(path.join(tmpDir, name), content);
}

describe('subject derivation', () => {
  it('derives the subject from the filename', () => {
    expect(subjectForFile('iam.identity.created.v1-value.proto')).toBe(
      'iam.identity.created.v1-value',
    );
  });

  it('derives the subject from the topic with TopicNameStrategy', () => {
    expect(subjectForTopic('iam.identity.created.v1')).toBe('iam.identity.created.v1-value');
  });

  it('file and topic derivations agree — this is what prevents drift', () => {
    const topic = 'iam.identity.created.v1';
    expect(subjectForFile(`${topic}-value.proto`)).toBe(subjectForTopic(topic));
  });
});

describe('readSchemaSources', () => {
  it('reads .proto files sorted by name', async () => {
    await writeProto('b-value.proto');
    await writeProto('a-value.proto');

    const sources = await readSchemaSources({ dir: tmpDir, log });

    expect(sources.map(s => s.file)).toEqual(['a-value.proto', 'b-value.proto']);
    expect(sources[0].schema).toContain('message IdentityCreated');
  });

  it('ignores non-.proto files', async () => {
    await writeProto('kept-value.proto');
    await fs.writeFile(path.join(tmpDir, 'README.md'), '# nope');
    await fs.writeFile(path.join(tmpDir, 'old-value.avsc'), '{}');

    const sources = await readSchemaSources({ dir: tmpDir, log });

    expect(sources.map(s => s.file)).toEqual(['kept-value.proto']);
  });

  it('strips a UTF-8 BOM', async () => {
    await writeProto('bom-value.proto', `\uFEFF${IDENTITY_PROTO}`);

    const [source] = await readSchemaSources({ dir: tmpDir, log });

    expect(source.schema.startsWith('syntax')).toBe(true);
  });

  it('warns and returns [] for a missing directory', async () => {
    const sources = await readSchemaSources({
      dir: path.join(tmpDir, 'does-not-exist'),
      log,
    });

    expect(sources).toEqual([]);
    expect(log.warnings.join(' ')).toMatch(/not found/);
  });

  it('warns and returns [] for a path that is a file, not a directory', async () => {
    const filePath = path.join(tmpDir, 'not-a-dir');
    await fs.writeFile(filePath, 'x');

    await expect(readSchemaSources({ dir: filePath, log })).resolves.toEqual([]);
  });

  it('warns and returns [] for an empty directory', async () => {
    const sources = await readSchemaSources({ dir: tmpDir, log });

    expect(sources).toEqual([]);
    expect(log.warnings.join(' ')).toMatch(/no \.proto files found/);
  });

  it('honours a custom subjectFor', async () => {
    await writeProto('identity.proto');

    const [source] = await readSchemaSources({
      dir: tmpDir,
      log,
      subjectFor: file => `custom.${file}`,
    });

    expect(source.subject).toBe('custom.identity.proto');
  });
});

describe('registerSchemas', () => {
  it('registers every .proto as PROTOBUF under its subject', async () => {
    await writeProto('iam.identity.created.v1-value.proto');
    const registry = fakeRegistry({ register: vi.fn(async () => 7) });

    const registered = await registerSchemas({
      client: fakeClient(baseConfig, registry),
      dir: tmpDir,
      log,
    });

    expect(registered).toEqual([
      { subject: 'iam.identity.created.v1-value', id: 7, file: 'iam.identity.created.v1-value.proto' },
    ]);
    expect(registry.register).toHaveBeenCalledWith(
      'iam.identity.created.v1-value',
      expect.stringContaining('message IdentityCreated'),
    );
  });

  it('is idempotent — an unchanged schema returns the same id, no local state', async () => {
    await writeProto('a-value.proto');
    const registry = fakeRegistry({ register: vi.fn(async () => ({ id: 11 })) });
    const client = fakeClient(baseConfig, registry);

    const first = await registerSchemas({ client, dir: tmpDir, log });
    const second = await registerSchemas({ client, dir: tmpDir, log });

    expect(first).toEqual(second);
    // No ledger, no version prefixes: it just posts again and the registry
    // answers with the id it already had.
    expect(registry.register).toHaveBeenCalledTimes(2);
  });

  it('registers multiple subjects in filename order', async () => {
    await writeProto('b-value.proto');
    await writeProto('a-value.proto');
    let next = 100;
    const registry = fakeRegistry({ register: vi.fn(async () => next++) });

    const registered = await registerSchemas({
      client: fakeClient(baseConfig, registry),
      dir: tmpDir,
      log,
    });

    expect(registered.map(r => r.subject)).toEqual(['a-value', 'b-value']);
    expect(registered.map(r => r.id)).toEqual([100, 101]);
  });

  it('throws SchemaRegistrationError when the registry rejects an incompatible change', async () => {
    await writeProto('iam.identity.created.v1-value.proto');
    const registry = fakeRegistry({
      register: vi.fn(async () => {
        throw new Error('Schema being registered is incompatible with an earlier schema');
      }),
    });

    const promise = registerSchemas({
      client: fakeClient(baseConfig, registry),
      dir: tmpDir,
      log,
    });

    await expect(promise).rejects.toBeInstanceOf(SchemaRegistrationError);
    await expect(promise).rejects.toThrow(/incompatible with an earlier schema/);
  });

  it('names the subject and file on the incompatibility error', async () => {
    await writeProto('orders-value.proto');
    const registry = fakeRegistry({
      register: vi.fn(async () => {
        throw new Error('incompatible');
      }),
    });

    try {
      await registerSchemas({ client: fakeClient(baseConfig, registry), dir: tmpDir, log });
      expect.unreachable('should have thrown');
    } catch (err) {
      const error = err as SchemaRegistrationError;
      expect(error.subject).toBe('orders-value');
      expect(error.file).toBe('orders-value.proto');
      expect(error.cause).toBeInstanceOf(Error);
    }
  });

  it('stops at the first failure — it does not press on', async () => {
    await writeProto('a-value.proto');
    await writeProto('b-value.proto');
    const registry = fakeRegistry({
      register: vi.fn(async () => {
        throw new Error('nope');
      }),
    });

    await expect(
      registerSchemas({ client: fakeClient(baseConfig, registry), dir: tmpDir, log }),
    ).rejects.toBeInstanceOf(SchemaRegistrationError);
    expect(registry.register).toHaveBeenCalledTimes(1);
  });

  it('returns [] and does not throw when the directory is missing', async () => {
    const registry = fakeRegistry();

    const registered = await registerSchemas({
      client: fakeClient(baseConfig, registry),
      dir: path.join(tmpDir, 'nope'),
      log,
    });

    expect(registered).toEqual([]);
    expect(registry.register).not.toHaveBeenCalled();
    expect(log.warnings.join(' ')).toMatch(/not found/);
  });

  it('falls back to the client config schemasDir', async () => {
    await writeProto('a-value.proto');
    const registry = fakeRegistry();

    const registered = await registerSchemas({
      client: fakeClient({ ...baseConfig, schemasDir: tmpDir }, registry),
      log,
    });

    expect(registered).toHaveLength(1);
  });

  it('accepts a standalone registry override', async () => {
    await writeProto('a-value.proto');
    const clientRegistry = fakeRegistry();
    const override = fakeRegistry({ register: vi.fn(async () => 99) });

    const registered = await registerSchemas({
      client: fakeClient(baseConfig, clientRegistry),
      registry: override,
      dir: tmpDir,
      log,
    });

    expect(registered[0].id).toBe(99);
    expect(clientRegistry.register).not.toHaveBeenCalled();
  });

  it('logs registered subjects', async () => {
    await writeProto('a-value.proto');

    await registerSchemas({ client: fakeClient(), dir: tmpDir, log });

    expect(log.infos.join(' ')).toMatch(/Registered schemas/);
  });
});

describe('checkSchemaCompatibility', () => {
  it('posts each schema to the compatibility endpoint without registering', async () => {
    await writeProto('iam.identity.created.v1-value.proto');
    const registry = fakeRegistry();
    const fetchImpl = fakeFetch([{ body: { is_compatible: true } }]);

    const results = await checkSchemaCompatibility({
      client: fakeClient(baseConfig, registry),
      dir: tmpDir,
      fetchImpl,
      log,
    });

    expect(results).toEqual([
      {
        subject: 'iam.identity.created.v1-value',
        file: 'iam.identity.created.v1-value.proto',
        compatible: true,
        messages: [],
        newSubject: false,
      },
    ]);
    expect(registry.register).not.toHaveBeenCalled();
    expect(fetchImpl.calls[0].url).toBe(
      'http://redpanda:8081/compatibility/subjects/iam.identity.created.v1-value/versions/latest?verbose=true',
    );
  });

  it('sends PROTOBUF as the schema type', async () => {
    await writeProto('a-value.proto');
    const fetchImpl = fakeFetch([{ body: { is_compatible: true } }]);

    await checkSchemaCompatibility({ client: fakeClient(), dir: tmpDir, fetchImpl, log });

    const body = JSON.parse(String(fetchImpl.calls[0].init?.body));
    expect(body.schemaType).toBe('PROTOBUF');
    expect(body.schema).toContain('message IdentityCreated');
  });

  it('reports an incompatible subject rather than throwing — CI decides', async () => {
    await writeProto('a-value.proto');
    const fetchImpl = fakeFetch([
      { body: { is_compatible: false, messages: ['field 2 was removed'] } },
    ]);

    const [result] = await checkSchemaCompatibility({
      client: fakeClient(),
      dir: tmpDir,
      fetchImpl,
      log,
    });

    expect(result.compatible).toBe(false);
    expect(result.messages).toEqual(['field 2 was removed']);
  });

  it('treats a 404 as a brand new subject', async () => {
    await writeProto('a-value.proto');
    const fetchImpl = fakeFetch([{ status: 404, body: { error_code: 40401 } }]);

    const [result] = await checkSchemaCompatibility({
      client: fakeClient(),
      dir: tmpDir,
      fetchImpl,
      log,
    });

    expect(result).toMatchObject({ compatible: true, newSubject: true, messages: [] });
  });

  it('throws SchemaRegistrationError on a registry error', async () => {
    await writeProto('a-value.proto');
    const fetchImpl = fakeFetch([{ status: 500, text: 'boom' }]);

    await expect(
      checkSchemaCompatibility({ client: fakeClient(), dir: tmpDir, fetchImpl, log }),
    ).rejects.toBeInstanceOf(SchemaRegistrationError);
  });

  it('sends basic auth when the registry is protected', async () => {
    await writeProto('a-value.proto');
    const fetchImpl = fakeFetch([{ body: { is_compatible: true } }]);

    await checkSchemaCompatibility({
      client: fakeClient({
        ...baseConfig,
        schemaRegistry: { url: 'http://sr:8081', auth: { username: 'u', password: 'p' } },
      }),
      dir: tmpDir,
      fetchImpl,
      log,
    });

    const headers = fetchImpl.calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
  });

  it('checks a pinned version when asked', async () => {
    await writeProto('a-value.proto');
    const fetchImpl = fakeFetch([{ body: { is_compatible: true } }]);

    await checkSchemaCompatibility({
      client: fakeClient(),
      dir: tmpDir,
      version: 3,
      fetchImpl,
      log,
    });

    expect(fetchImpl.calls[0].url).toContain('/versions/3?');
  });

  it('normalises a trailing slash on the registry url', async () => {
    await writeProto('a-value.proto');
    const fetchImpl = fakeFetch([{ body: { is_compatible: true } }]);

    await checkSchemaCompatibility({
      client: fakeClient({ ...baseConfig, schemaRegistry: { url: 'http://sr:8081//' } }),
      dir: tmpDir,
      fetchImpl,
      log,
    });

    expect(fetchImpl.calls[0].url.startsWith('http://sr:8081/compatibility/')).toBe(true);
  });

  it('returns [] when there is nothing to check', async () => {
    const fetchImpl = fakeFetch([]);

    await expect(
      checkSchemaCompatibility({ client: fakeClient(), dir: tmpDir, fetchImpl, log }),
    ).resolves.toEqual([]);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});
