import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runPersistenceAdapterContract } from '@starter/core/test-support';
import { createD1Adapters, type D1Database } from './index.js';

let runtime: Miniflare;
let database: D1Database;

const applyMigration = async (database: D1Database, migration: string) => {
  for (const statement of migration
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.prepare(statement).run();
  }
};

beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: `db-${crypto.randomUUID()}` },
  });
  database = (await runtime.getD1Database('DB')) as D1Database;
  const migration = await readFile(
    new URL('../migrations/0001_initial.sql', import.meta.url),
    'utf8',
  );
  await applyMigration(database, migration);
});

runPersistenceAdapterContract({
  describe,
  test,
  expect,
  create: async () => {
    await database.batch([
      database.prepare('DELETE FROM activities'),
      database.prepare('DELETE FROM jobs'),
      database.prepare('DELETE FROM deliveries'),
      database.prepare('DELETE FROM secrets'),
      database.prepare('DELETE FROM installations'),
    ]);
    return {
      ...createD1Adapters({
        database,
        rootKey: new Uint8Array(32).fill(7),
        keyVersion: 3,
      }),
      inspectStoredSecret: async (installationId, kind) => {
        const row = await database
          .prepare(
            'SELECT algorithm, key_version, iv, ciphertext FROM secrets WHERE installation_id = ? AND kind = ?',
          )
          .bind(installationId, kind)
          .first<{
            algorithm: string;
            key_version: number;
            iv: string;
            ciphertext: string;
          }>();
        return row === null
          ? undefined
          : {
              algorithm: row.algorithm,
              keyVersion: row.key_version,
              iv: row.iv,
              ciphertext: row.ciphertext,
              containsPlaintext: Object.values(row).includes('first secret'),
            };
      },
      copyStoredSecretToInstallation: async (
        sourceInstallationId,
        targetInstallationId,
        kind,
      ) => {
        await database
          .prepare(
            `INSERT INTO secrets (installation_id, kind, algorithm, key_version, iv, ciphertext, created_at, updated_at) SELECT ?, kind, algorithm, key_version, iv, ciphertext, created_at, updated_at FROM secrets WHERE installation_id = ? AND kind = ?`,
          )
          .bind(targetInstallationId, sourceInstallationId, kind)
          .run();
      },
      seedJob: async ({ jobId, installationId, status }) => {
        const at = '2026-07-19T12:00:00.000Z';
        await database
          .prepare(
            'INSERT INTO jobs (job_id, installation_id, payload_reference, attempt, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(jobId, installationId, `ref-${jobId}`, 0, status, at, at, at)
          .run();
      },
      getJobStatus: async (jobId) =>
        (
          await database
            .prepare('SELECT status FROM jobs WHERE job_id = ?')
            .bind(jobId)
            .first<{ status: string }>()
        )?.status,
      cleanup: async () => undefined,
    };
  },
});

describe('D1 schema', () => {
  test('stores encrypted envelope fields and no plaintext secret column', async () => {
    const columns = await database
      .prepare('PRAGMA table_info(secrets)')
      .all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['algorithm', 'key_version', 'iv', 'ciphertext']),
    );
    expect(columns.results.map(({ name }) => name)).not.toContain('plaintext');
  });
});

afterAll(async () => {
  await runtime.dispose();
});
