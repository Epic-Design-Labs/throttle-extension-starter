import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runPersistenceAdapterContract } from '@starter/core/test-support';
import { createD1Adapters, type D1Database } from './index.js';

let runtime: Miniflare;
let database: D1Database;
const credentialKeys = new Map<number, Uint8Array>();
let currentCredentialKeyVersion = 3;
const keyring = {
  current: () => ({
    version: currentCredentialKeyVersion,
    key: credentialKeys.get(currentCredentialKeyVersion)!,
  }),
  resolve: (version: number) => credentialKeys.get(version),
};

const applyMigration = async (database: D1Database, migration: string) => {
  const statements: string[] = [];
  let pending = '';
  let trigger = false;
  for (const line of migration.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (pending.length === 0) trigger = trimmed.startsWith('CREATE TRIGGER');
    pending += `${trimmed}\n`;
    if (
      (!trigger && trimmed.endsWith(';')) ||
      (trigger && trimmed.endsWith('END;'))
    ) {
      statements.push(pending.trim());
      pending = '';
      trigger = false;
    }
  }
  if (pending.trim().length > 0)
    throw new Error('Incomplete migration statement');
  for (const statement of statements) {
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
    credentialKeys.clear();
    credentialKeys.set(3, new Uint8Array(32).fill(7));
    currentCredentialKeyVersion = 3;
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
        credentialKeys: keyring,
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
      setJobStatus: async (
        jobId: string,
        status: 'pending' | 'retry' | 'processing',
      ) => {
        await database
          .prepare(
            'UPDATE jobs SET status = ?, updated_at = ? WHERE job_id = ?',
          )
          .bind(status, new Date().toISOString(), jobId)
          .run();
      },
      rotateCredentialKey: (version, key) => {
        credentialKeys.set(version, new Uint8Array(key));
        currentCredentialKeyVersion = version;
      },
      removeCredentialKey: (version) => {
        credentialKeys.delete(version);
      },
      cleanup: async () => undefined,
    };
  },
});

describe('D1 schema', () => {
  test('trusted job lookup reloads state while provider reference update remains scoped and lifecycle-safe', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const value = {
      installationId: 'job-installation',
      workspaceId: 'job-workspace',
      applicationId: 'job-app',
      environmentId: 'job-env',
      environmentKind: 'non_production' as const,
      extensionVersion: '1',
      status: 'active' as const,
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    };
    await adapters.installations.upsert(value);
    expect(
      await adapters.installations.getForJob(value.installationId),
    ).toEqual(value);
    await expect(
      adapters.installations.updateProviderAccountReference(
        value.installationId,
        {
          workspaceId: 'wrong',
          applicationId: value.applicationId,
          environmentId: value.environmentId,
        },
        'account',
        new Date('2026-07-19T11:00:00.000Z'),
      ),
    ).rejects.toThrow();
    const updated = await adapters.installations.updateProviderAccountReference(
      value.installationId,
      value,
      'account',
      new Date('2026-07-19T11:00:00.000Z'),
    );
    expect(updated.workspaceId).toBe(value.workspaceId);
    expect(updated.providerAccountReference).toBe('account');
    await adapters.installations.markUninstalled(
      value.installationId,
      value,
      new Date('2026-07-19T12:00:00.000Z'),
    );
    await expect(
      adapters.installations.updateProviderAccountReference(
        value.installationId,
        value,
        'other',
        new Date('2026-07-19T13:00:00.000Z'),
      ),
    ).rejects.toThrow();
  });

  test('activity append is idempotent by activity id', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    await adapters.installations.upsert({
      installationId: 'activity-installation',
      workspaceId: 'activity-workspace',
      applicationId: 'activity-app',
      environmentId: 'activity-env',
      environmentKind: 'non_production',
      extensionVersion: '1',
      status: 'active',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    const value = {
      activityId: 'attempt-once',
      installationId: 'activity-installation',
      jobId: 'job',
      eventId: 'event',
      type: 'connector_sync' as const,
      status: 'completed' as const,
      result: 'success' as const,
      attempt: 1,
      createdAt: '2026-07-19T10:00:00.000Z',
    };
    await adapters.activities.append(value);
    await adapters.activities.append(value);
    expect(
      await adapters.activities.list({
        installationId: value.installationId,
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  test('stores encrypted envelope fields and no plaintext secret column', async () => {
    const columns = await database
      .prepare('PRAGMA table_info(secrets)')
      .all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining(['algorithm', 'key_version', 'iv', 'ciphertext']),
    );
    expect(columns.results.map(({ name }) => name)).not.toContain('plaintext');
  });

  test('rolls back every uninstall statement when middle cleanup fails', async () => {
    await database.batch([
      database.prepare('DELETE FROM jobs'),
      database.prepare('DELETE FROM secrets'),
      database.prepare('DELETE FROM installations'),
    ]);
    credentialKeys.clear();
    credentialKeys.set(3, new Uint8Array(32).fill(7));
    currentCredentialKeyVersion = 3;
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const scope = {
      workspaceId: 'rollback-workspace',
      applicationId: 'rollback-app',
      environmentId: 'rollback-env',
    };
    await adapters.installations.upsert({
      installationId: 'rollback-installation',
      ...scope,
      environmentKind: 'non_production',
      extensionVersion: '1.0.0',
      status: 'active',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    await adapters.credentials.set(
      'rollback-installation',
      'throttleApiKey',
      new Uint8Array([1]),
    );
    const at = '2026-07-19T12:00:00.000Z';
    await database
      .prepare(
        'INSERT INTO jobs (job_id, installation_id, payload_reference, attempt, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)',
      )
      .bind(
        'rollback-job',
        'rollback-installation',
        'ref',
        'pending',
        at,
        at,
        at,
      )
      .run();
    await database
      .prepare(
        "CREATE TRIGGER fail_secret_cleanup BEFORE DELETE ON secrets WHEN OLD.installation_id = 'rollback-installation' BEGIN SELECT RAISE(ABORT, 'forced cleanup failure'); END",
      )
      .run();
    try {
      await expect(
        adapters.installations.markUninstalled(
          'rollback-installation',
          scope,
          new Date('2026-07-19T15:00:00.000Z'),
        ),
      ).rejects.toThrow('forced cleanup failure');
    } finally {
      await database.prepare('DROP TRIGGER fail_secret_cleanup').run();
    }
    expect(
      (await adapters.installations.get('rollback-installation', scope))
        ?.status,
    ).toBe('active');
    expect(
      await adapters.credentials.get('rollback-installation', 'throttleApiKey'),
    ).toEqual(new Uint8Array([1]));
    expect(
      (
        await database
          .prepare('SELECT status FROM jobs WHERE job_id = ?')
          .bind('rollback-job')
          .first<{ status: string }>()
      )?.status,
    ).toBe('pending');
  });
});

afterAll(async () => {
  await runtime.dispose();
});
