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
const executionActivity = (
  jobId: string,
  installationId: string,
  attempt: number,
  result: 'success' | 'retryable_failure' = 'success',
) => ({
  activityId: `${jobId}:${attempt}`,
  installationId,
  jobId,
  type: 'connector_sync' as const,
  status: 'completed' as const,
  result,
  attempt,
  createdAt: '2026-07-19T10:00:00.000Z',
});

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
  test('fences an expired claimant with a distinct token', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const scope = {
      workspaceId: 'fence-workspace',
      applicationId: 'fence-app',
      environmentId: 'fence-env',
    };
    await adapters.installations.upsert({
      installationId: 'fence-installation',
      ...scope,
      environmentKind: 'non_production',
      extensionVersion: '1',
      status: 'active',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    const at = '2026-07-19T10:00:00.000Z';
    await database
      .prepare(
        'INSERT INTO jobs (job_id,installation_id,payload_reference,attempt,status,scheduled_at,created_at,updated_at,lease_expires_at,lease_token) VALUES (?,?,?,0,?,?,?,?,NULL,NULL)',
      )
      .bind('fence-job', 'fence-installation', 'ref', 'pending', at, at, at)
      .run();
    const first = await adapters.executions.claim({
      jobId: 'fence-job',
      attempt: 1,
      now: new Date(at),
    });
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') throw new Error('expected claim');
    expect(
      await adapters.executions.claim({
        jobId: 'fence-job',
        attempt: 1,
        now: new Date(at),
      }),
    ).toMatchObject({ status: 'busy', retryAfterSeconds: 300 });
    await database
      .prepare('UPDATE jobs SET lease_expires_at=? WHERE job_id=?')
      .bind('2026-07-19T10:00:00.100Z', 'fence-job')
      .run();
    expect(
      await adapters.executions.claim({
        jobId: 'fence-job',
        attempt: 1,
        now: new Date(at),
      }),
    ).toMatchObject({ status: 'busy', retryAfterSeconds: 1 });
    await database
      .prepare('UPDATE jobs SET lease_expires_at=? WHERE job_id=?')
      .bind('2026-07-19T09:59:00.000Z', 'fence-job')
      .run();
    const second = await adapters.executions.claim({
      jobId: 'fence-job',
      attempt: 1,
      now: new Date(at),
    });
    expect(second.status).toBe('claimed');
    if (second.status !== 'claimed') throw new Error('expected reclaim');
    expect(second.token).not.toBe(first.token);
    expect(
      await adapters.executions.finish({
        jobId: 'fence-job',
        attempt: 1,
        token: first.token,
        status: 'retry',
        activity: executionActivity('fence-job', 'fence-installation', 1),
        now: new Date(at),
      }),
    ).toBe('stale');
    expect(
      await adapters.executions.finish({
        jobId: 'fence-job',
        attempt: 1,
        token: 'wrong-token',
        status: 'retry',
        activity: executionActivity('fence-job', 'fence-installation', 1),
        now: new Date(at),
      }),
    ).toBe('stale');
    expect(
      await adapters.executions.finish({
        jobId: 'fence-job',
        attempt: 1,
        token: second.token,
        status: 'retry',
        activity: executionActivity(
          'fence-job',
          'fence-installation',
          1,
          'retryable_failure',
        ),
        now: new Date(at),
      }),
    ).toBe('finished');
    expect(
      await adapters.activities.list({
        installationId: 'fence-installation',
        limit: 10,
      }),
    ).toMatchObject([
      { activityId: 'fence-job:1', result: 'retryable_failure' },
    ]);
  });
  test('rolls back outcome activity when fenced job transition fails', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const scope = {
      workspaceId: 'finish-rollback-workspace',
      applicationId: 'finish-rollback-app',
      environmentId: 'finish-rollback-env',
    };
    await adapters.installations.upsert({
      installationId: 'finish-rollback-installation',
      ...scope,
      environmentKind: 'non_production',
      extensionVersion: '1',
      status: 'active',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    const at = '2026-07-19T10:00:00.000Z';
    await database
      .prepare(
        'INSERT INTO jobs (job_id,installation_id,payload_reference,attempt,status,scheduled_at,created_at,updated_at,lease_expires_at,lease_token) VALUES (?,?,?,0,?,?,?,?,NULL,NULL)',
      )
      .bind(
        'finish-rollback-job',
        'finish-rollback-installation',
        'ref',
        'pending',
        at,
        at,
        at,
      )
      .run();
    const claim = await adapters.executions.claim({
      jobId: 'finish-rollback-job',
      attempt: 1,
      now: new Date(at),
    });
    if (claim.status !== 'claimed') throw new Error('expected claim');
    await database
      .prepare(
        "CREATE TRIGGER fail_fenced_finish BEFORE UPDATE ON jobs WHEN OLD.job_id='finish-rollback-job' AND NEW.status='completed' BEGIN SELECT RAISE(ABORT,'forced finish failure'); END",
      )
      .run();
    try {
      await expect(
        adapters.executions.finish({
          jobId: 'finish-rollback-job',
          attempt: 1,
          token: claim.token,
          status: 'completed',
          activity: executionActivity(
            'finish-rollback-job',
            'finish-rollback-installation',
            1,
          ),
          now: new Date(at),
        }),
      ).rejects.toThrow('forced finish failure');
    } finally {
      await database.prepare('DROP TRIGGER fail_fenced_finish').run();
    }
    expect(
      await adapters.activities.list({
        installationId: 'finish-rollback-installation',
        limit: 10,
      }),
    ).toHaveLength(0);
    expect(
      (
        await database
          .prepare('SELECT status FROM jobs WHERE job_id=?')
          .bind('finish-rollback-job')
          .first<{ status: string }>()
      )?.status,
    ).toBe('processing');
  });
  test('atomically claims one concurrent execution and completes it', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const scope = {
      workspaceId: 'claim-workspace',
      applicationId: 'claim-app',
      environmentId: 'claim-env',
    };
    await adapters.installations.upsert({
      installationId: 'claim-installation',
      ...scope,
      environmentKind: 'non_production',
      extensionVersion: '1',
      status: 'active',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    const at = '2026-07-19T10:00:00.000Z';
    await database
      .prepare(
        'INSERT INTO jobs (job_id, installation_id, payload_reference, attempt, status, scheduled_at, created_at, updated_at, lease_expires_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL)',
      )
      .bind('claim-job', 'claim-installation', 'ref', 'pending', at, at, at)
      .run();
    const claims = await Promise.all([
      adapters.executions.claim({
        jobId: 'claim-job',
        attempt: 1,
        now: new Date(at),
      }),
      adapters.executions.claim({
        jobId: 'claim-job',
        attempt: 1,
        now: new Date(at),
      }),
    ]);
    expect(claims.map((claim) => claim.status).sort()).toEqual([
      'busy',
      'claimed',
    ]);
    expect(claims.find((claim) => claim.status === 'busy')).toMatchObject({
      status: 'busy',
      retryAfterSeconds: 300,
    });
    const claimed = claims.find((claim) => claim.status === 'claimed');
    if (claimed?.status !== 'claimed') throw new Error('expected claim');
    await adapters.executions.finish({
      jobId: 'claim-job',
      attempt: 1,
      token: claimed.token,
      status: 'completed',
      activity: executionActivity('claim-job', 'claim-installation', 1),
      now: new Date(at),
    });
    expect(
      await adapters.executions.claim({
        jobId: 'claim-job',
        attempt: 1,
        now: new Date(at),
      }),
    ).toMatchObject({ status: 'duplicate' });
  });

  test('advances retry attempts exactly once and rejects stale or skipped attempts', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const scope = {
      workspaceId: 'progress-workspace',
      applicationId: 'progress-app',
      environmentId: 'progress-env',
    };
    await adapters.installations.upsert({
      installationId: 'progress-installation',
      ...scope,
      environmentKind: 'non_production',
      extensionVersion: '1',
      status: 'active',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    const at = '2026-07-19T10:00:00.000Z';
    await database
      .prepare(
        'INSERT INTO jobs (job_id, installation_id, payload_reference, attempt, status, scheduled_at, created_at, updated_at, lease_expires_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL)',
      )
      .bind(
        'progress-job',
        'progress-installation',
        'ref',
        'pending',
        at,
        at,
        at,
      )
      .run();
    const progressClaim = await adapters.executions.claim({
      jobId: 'progress-job',
      attempt: 1,
      now: new Date(at),
    });
    expect(progressClaim).toMatchObject({ status: 'claimed' });
    if (progressClaim.status !== 'claimed') throw new Error('expected claim');
    await adapters.executions.finish({
      jobId: 'progress-job',
      attempt: 1,
      token: progressClaim.token,
      status: 'retry',
      activity: executionActivity(
        'progress-job',
        'progress-installation',
        1,
        'retryable_failure',
      ),
      now: new Date(at),
    });
    expect(
      await adapters.executions.claim({
        jobId: 'progress-job',
        attempt: 1,
        now: new Date(at),
      }),
    ).toMatchObject({ status: 'duplicate' });
    expect(
      await adapters.executions.claim({
        jobId: 'progress-job',
        attempt: 3,
        now: new Date(at),
      }),
    ).toMatchObject({ status: 'unavailable' });
    expect(
      await adapters.executions.claim({
        jobId: 'progress-job',
        attempt: 2,
        now: new Date(at),
      }),
    ).toMatchObject({ status: 'claimed' });
  });

  test('reclaims only the same attempt after its processing lease expires', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const scope = {
      workspaceId: 'lease-workspace',
      applicationId: 'lease-app',
      environmentId: 'lease-env',
    };
    await adapters.installations.upsert({
      installationId: 'lease-installation',
      ...scope,
      environmentKind: 'non_production',
      extensionVersion: '1',
      status: 'active',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    const at = '2026-07-19T10:00:00.000Z';
    await database
      .prepare(
        'INSERT INTO jobs (job_id, installation_id, payload_reference, attempt, status, scheduled_at, created_at, updated_at, lease_expires_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL)',
      )
      .bind('lease-job', 'lease-installation', 'ref', 'pending', at, at, at)
      .run();
    expect(
      await adapters.executions.claim({
        jobId: 'lease-job',
        attempt: 1,
        now: new Date(at),
      }),
    ).toMatchObject({ status: 'claimed' });
    await database
      .prepare('UPDATE jobs SET lease_expires_at=? WHERE job_id=?')
      .bind('2026-07-19T09:59:00.000Z', 'lease-job')
      .run();
    expect(
      await adapters.executions.claim({
        jobId: 'lease-job',
        attempt: 2,
        now: new Date(at),
      }),
    ).toMatchObject({ status: 'unavailable' });
    expect(
      await adapters.executions.claim({
        jobId: 'lease-job',
        attempt: 1,
        now: new Date(at),
      }),
    ).toMatchObject({ status: 'claimed' });
  });

  test('uninstall cancels processing jobs and late finish cannot resurrect them', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const scope = {
      workspaceId: 'race-uninstall-workspace',
      applicationId: 'race-uninstall-app',
      environmentId: 'race-uninstall-env',
    };
    await adapters.installations.upsert({
      installationId: 'race-uninstall-installation',
      ...scope,
      environmentKind: 'non_production',
      extensionVersion: '1',
      status: 'active',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    const at = '2026-07-19T10:00:00.000Z';
    await database
      .prepare(
        'INSERT INTO jobs (job_id,installation_id,payload_reference,attempt,status,scheduled_at,created_at,updated_at,lease_expires_at) VALUES (?,?,?,0,?,?,?,?,NULL)',
      )
      .bind(
        'race-uninstall-job',
        'race-uninstall-installation',
        'ref',
        'pending',
        at,
        at,
        at,
      )
      .run();
    await database.batch([
      database
        .prepare(
          'INSERT INTO jobs (job_id,installation_id,payload_reference,attempt,status,scheduled_at,created_at,updated_at,lease_expires_at) VALUES (?,?,?,1,?,?,?,?,NULL)',
        )
        .bind(
          'race-completed-job',
          'race-uninstall-installation',
          'ref',
          'completed',
          at,
          at,
          at,
        ),
      database
        .prepare(
          'INSERT INTO jobs (job_id,installation_id,payload_reference,attempt,status,scheduled_at,created_at,updated_at,lease_expires_at) VALUES (?,?,?,1,?,?,?,?,NULL)',
        )
        .bind(
          'race-failed-job',
          'race-uninstall-installation',
          'ref',
          'failed',
          at,
          at,
          at,
        ),
    ]);
    const uninstallClaim = await adapters.executions.claim({
      jobId: 'race-uninstall-job',
      attempt: 1,
      now: new Date(at),
    });
    expect(uninstallClaim).toMatchObject({ status: 'claimed' });
    if (uninstallClaim.status !== 'claimed') throw new Error('expected claim');
    await adapters.installations.markUninstalled(
      'race-uninstall-installation',
      scope,
      new Date('2026-07-19T10:01:00.000Z'),
    );
    expect(
      await adapters.executions.finish({
        jobId: 'race-uninstall-job',
        attempt: 1,
        token: uninstallClaim.token,
        status: 'retry',
        activity: executionActivity(
          'race-uninstall-job',
          'race-uninstall-installation',
          1,
          'retryable_failure',
        ),
        now: new Date('2026-07-19T10:02:00.000Z'),
      }),
    ).toBe('cancelled');
    expect(
      await adapters.activities.list({
        installationId: 'race-uninstall-installation',
        limit: 10,
      }),
    ).toHaveLength(0);
    expect(
      await adapters.executions.claim({
        jobId: 'race-uninstall-job',
        attempt: 1,
        now: new Date('2026-07-19T11:00:00.000Z'),
      }),
    ).toMatchObject({ status: 'duplicate' });
    expect(
      (
        await database
          .prepare('SELECT status, lease_token FROM jobs WHERE job_id=?')
          .bind('race-uninstall-job')
          .first<{ status: string; lease_token: string | null }>()
      )?.status,
    ).toBe('cancelled');
    expect(
      (
        await database
          .prepare('SELECT lease_token FROM jobs WHERE job_id=?')
          .bind('race-uninstall-job')
          .first<{ lease_token: string | null }>()
      )?.lease_token,
    ).toBeNull();
    expect(
      (
        await database
          .prepare('SELECT status FROM jobs WHERE job_id=?')
          .bind('race-completed-job')
          .first<{ status: string }>()
      )?.status,
    ).toBe('completed');
    expect(
      (
        await database
          .prepare('SELECT status FROM jobs WHERE job_id=?')
          .bind('race-failed-job')
          .first<{ status: string }>()
      )?.status,
    ).toBe('failed');
  });

  test('provider connection commit rolls back account metadata when secret persistence fails', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const scope = {
      workspaceId: 'atomic-workspace',
      applicationId: 'atomic-app',
      environmentId: 'atomic-env',
    };
    await adapters.installations.upsert({
      installationId: 'atomic-installation',
      ...scope,
      environmentKind: 'non_production',
      extensionVersion: '1',
      status: 'active',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    await database
      .prepare(
        "CREATE TRIGGER fail_atomic_secret BEFORE INSERT ON secrets WHEN NEW.installation_id = 'atomic-installation' BEGIN SELECT RAISE(ABORT, 'forced atomic failure'); END",
      )
      .run();
    try {
      await expect(
        adapters.connections.commit({
          installationId: 'atomic-installation',
          scope,
          credentials: new TextEncoder().encode('secret'),
          providerAccountReference: 'account',
          now: new Date('2026-07-19T11:00:00.000Z'),
        }),
      ).rejects.toThrow('forced atomic failure');
    } finally {
      await database.prepare('DROP TRIGGER fail_atomic_secret').run();
    }
    expect(
      (await adapters.installations.get('atomic-installation', scope))
        ?.providerAccountReference,
    ).toBeUndefined();
    expect(
      await adapters.credentials.get(
        'atomic-installation',
        'providerCredentials',
      ),
    ).toBeUndefined();
  });

  test('provider connection result preserves existing sync cursor and immutable identity', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const scope = {
      workspaceId: 'cursor-workspace',
      applicationId: 'cursor-app',
      environmentId: 'cursor-env',
    };
    const original = {
      installationId: 'cursor-installation',
      ...scope,
      environmentKind: 'non_production' as const,
      extensionVersion: '1',
      status: 'active' as const,
      lastSuccessfulSyncCursor: 'cursor-17',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    };
    await adapters.installations.upsert(original);
    const connected = await adapters.connections.commit({
      installationId: original.installationId,
      scope,
      credentials: new TextEncoder().encode('secret'),
      providerAccountReference: 'account',
      now: new Date('2026-07-19T11:00:00.000Z'),
    });
    expect(connected.lastSuccessfulSyncCursor).toBe('cursor-17');
    expect(connected.workspaceId).toBe(original.workspaceId);
    expect(
      (await adapters.installations.get(original.installationId, scope))
        ?.lastSuccessfulSyncCursor,
    ).toBe('cursor-17');
  });

  test('concurrent provider connection commits never mix account and credential', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    const scope = {
      workspaceId: 'race-workspace',
      applicationId: 'race-app',
      environmentId: 'race-env',
    };
    await adapters.installations.upsert({
      installationId: 'race-installation',
      ...scope,
      environmentKind: 'non_production',
      extensionVersion: '1',
      status: 'active',
      createdAt: '2026-07-19T10:00:00.000Z',
      updatedAt: '2026-07-19T10:00:00.000Z',
    });
    await Promise.all([
      adapters.connections.commit({
        installationId: 'race-installation',
        scope,
        credentials: new TextEncoder().encode('secret-a'),
        providerAccountReference: 'account-a',
        now: new Date('2026-07-19T11:00:00.000Z'),
      }),
      adapters.connections.commit({
        installationId: 'race-installation',
        scope,
        credentials: new TextEncoder().encode('secret-b'),
        providerAccountReference: 'account-b',
        now: new Date('2026-07-19T11:00:01.000Z'),
      }),
    ]);
    const account = (
      await adapters.installations.get('race-installation', scope)
    )?.providerAccountReference;
    const secret = new TextDecoder().decode(
      await adapters.credentials.get(
        'race-installation',
        'providerCredentials',
      ),
    );
    expect(`${account}:${secret}`).toEqual(
      expect.stringMatching(/^(account-a:secret-a|account-b:secret-b)$/),
    );
  });

  test('activity unrelated integrity failures reject', async () => {
    const adapters = createD1Adapters({ database, credentialKeys: keyring });
    await expect(
      adapters.activities.append({
        activityId: 'bad-fk',
        installationId: 'missing-installation',
        type: 'connector_sync',
        status: 'completed',
        result: 'success',
        attempt: 1,
        createdAt: '2026-07-19T10:00:00.000Z',
      }),
    ).rejects.toThrow();
  });
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
