import type { Activity, Installation } from '@starter/contracts';
import type {
  ActivityStore,
  CredentialStore,
  DeliveryStore,
  InstallationStore,
} from './ports.js';

type TestFn = (name: string, callback: () => Promise<void>) => void;
type Expect = (actual: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeUndefined(): void;
  toHaveLength(expected: number): void;
  not: {
    toHaveProperty(expected: string): void;
    toEqual(expected: unknown): void;
  };
  rejects: { toThrow(expected?: unknown): Promise<void> };
};

interface TestDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface PersistenceAdapterContractFactory {
  describe(name: string, callback: () => void): void;
  test: TestFn;
  expect: Expect;
  create(): Promise<{
    installations: InstallationStore;
    credentials: CredentialStore;
    deliveries: DeliveryStore;
    activities: ActivityStore;
    database: TestDatabase;
  }>;
}

const installation = (overrides: Partial<Installation> = {}): Installation => ({
  installationId: 'installation-a',
  workspaceId: 'workspace-a',
  applicationId: 'application-a',
  environmentId: 'environment-a',
  environmentKind: 'non_production',
  extensionVersion: '1.0.0',
  status: 'active',
  createdAt: '2026-07-19T10:00:00.000Z',
  updatedAt: '2026-07-19T10:00:00.000Z',
  ...overrides,
});

export function runPersistenceAdapterContract(
  factory: PersistenceAdapterContractFactory,
): void {
  const { describe, test, expect } = factory;
  describe('persistence adapter contract', () => {
    test('round-trips strict installations and upserts replacements', async () => {
      const { installations } = await factory.create();
      const original = installation();
      expect(await installations.upsert(original)).toEqual(original);
      const replacement = installation({
        extensionVersion: '2.0.0',
        updatedAt: '2026-07-19T11:00:00.000Z',
      });
      expect(await installations.upsert(replacement)).toEqual(replacement);
      expect(await installations.get(original.installationId)).toEqual(
        replacement,
      );
      expect(await installations.get('missing')).toBeUndefined();
    });

    test('isolates normal reads by installation, workspace, environment, and application', async () => {
      const { installations } = await factory.create();
      await Promise.all([
        installations.upsert(installation()),
        installations.upsert(
          installation({
            installationId: 'other-workspace',
            workspaceId: 'workspace-b',
          }),
        ),
        installations.upsert(
          installation({
            installationId: 'other-environment',
            environmentId: 'environment-b',
          }),
        ),
        installations.upsert(
          installation({
            installationId: 'other-application',
            applicationId: 'application-b',
          }),
        ),
      ]);
      expect(await installations.get('installation-a')).toEqual(installation());
      expect(await installations.get('other-application')).toEqual(
        installation({
          installationId: 'other-application',
          applicationId: 'application-b',
        }),
      );
    });

    test('webhook candidates use only workspace/environment, contain metadata only, and cap at 100', async () => {
      const { installations } = await factory.create();
      await Promise.all(
        Array.from({ length: 105 }, (_, index) =>
          installations.upsert(
            installation({
              installationId: `candidate-${String(index).padStart(3, '0')}`,
              applicationId: `app-${index}`,
            }),
          ),
        ),
      );
      await installations.upsert(
        installation({
          installationId: 'wrong-workspace',
          workspaceId: 'elsewhere',
        }),
      );
      await installations.upsert(
        installation({
          installationId: 'wrong-environment',
          environmentId: 'elsewhere',
        }),
      );
      const candidates = await installations.findWebhookVerificationCandidates({
        workspaceId: 'workspace-a',
        environmentId: 'environment-a',
      });
      expect(candidates).toHaveLength(100);
      expect(
        candidates.some((value) => value.applicationId !== 'application-a'),
      ).toBe(true);
      expect(
        candidates.some((value) => value.installationId === 'wrong-workspace'),
      ).toBe(false);
      expect(
        candidates.some(
          (value) => value.installationId === 'wrong-environment',
        ),
      ).toBe(false);
      for (const candidate of candidates)
        expect(candidate).not.toHaveProperty('secret');
    });

    test('sets, replaces, gets and deletes encrypted credentials by installation and kind', async () => {
      const { installations, credentials, database } = await factory.create();
      await installations.upsert(installation());
      await installations.upsert(
        installation({ installationId: 'installation-b' }),
      );
      const first = new TextEncoder().encode('first secret');
      await credentials.set('installation-a', 'providerCredentials', first);
      first.fill(0);
      expect(
        new TextDecoder().decode(
          await credentials.get('installation-a', 'providerCredentials'),
        ),
      ).toBe('first secret');
      expect(
        await credentials.get('installation-a', 'webhookSigningSecret'),
      ).toBeUndefined();
      expect(
        await credentials.get('installation-b', 'providerCredentials'),
      ).toBeUndefined();
      const row = await database
        .prepare('SELECT * FROM secrets WHERE installation_id = ? AND kind = ?')
        .bind('installation-a', 'providerCredentials')
        .first<Record<string, unknown>>();
      expect(row).not.toHaveProperty('plaintext');
      expect(Object.values(row ?? {}).includes('first secret')).toBe(false);
      await database
        .prepare(
          `INSERT INTO secrets (installation_id, kind, algorithm, key_version, iv, ciphertext, created_at, updated_at)
           SELECT ?, kind, algorithm, key_version, iv, ciphertext, created_at, updated_at
           FROM secrets WHERE installation_id = ? AND kind = ?`,
        )
        .bind('installation-b', 'installation-a', 'providerCredentials')
        .run();
      await expect(
        credentials.get('installation-b', 'providerCredentials'),
      ).rejects.toThrow('Unable to decrypt secret');
      await credentials.set(
        'installation-a',
        'providerCredentials',
        new TextEncoder().encode('replacement'),
      );
      expect(
        new TextDecoder().decode(
          await credentials.get('installation-a', 'providerCredentials'),
        ),
      ).toBe('replacement');
      await credentials.delete('installation-a', 'providerCredentials');
      expect(
        await credentials.get('installation-a', 'providerCredentials'),
      ).toBeUndefined();
      await expect(
        credentials.set('missing', 'providerCredentials', new Uint8Array([1])),
      ).rejects.toThrow();
    });

    test('accepts exactly one of two concurrent duplicate deliveries', async () => {
      const { installations, deliveries } = await factory.create();
      await installations.upsert(installation());
      const input = {
        installationId: 'installation-a',
        eventId: 'event-a',
        eventType: 'order.created',
        acceptedAt: new Date('2026-07-19T12:00:00.000Z'),
      };
      const results = await Promise.all([
        deliveries.accept(input),
        deliveries.accept(input),
      ]);
      expect(results.filter((result) => result.accepted)).toHaveLength(1);
      expect(results.filter((result) => !result.accepted)).toHaveLength(1);
    });

    test('lists bounded activity newest-first with stable id tie-break and installation isolation', async () => {
      const { installations, activities } = await factory.create();
      await installations.upsert(installation());
      await installations.upsert(
        installation({ installationId: 'installation-b' }),
      );
      const activity = (
        activityId: string,
        createdAt: string,
        installationId = 'installation-a',
      ): Activity => ({
        activityId,
        installationId,
        type: 'connector_sync',
        status: 'completed',
        result: 'success',
        attempt: 0,
        createdAt,
      });
      await activities.append(activity('b', '2026-07-19T12:00:00.000Z'));
      await activities.append(activity('a', '2026-07-19T12:00:00.000Z'));
      await activities.append(activity('newest', '2026-07-19T13:00:00.000Z'));
      await activities.append(
        activity('foreign', '2026-07-19T14:00:00.000Z', 'installation-b'),
      );
      expect(
        (
          await activities.list({ installationId: 'installation-a', limit: 2 })
        ).map(({ activityId }) => activityId),
      ).toEqual(['newest', 'b']);
      await expect(
        activities.list({ installationId: 'installation-a', limit: 0 }),
      ).rejects.toThrow();
      await expect(
        activities.list({ installationId: 'installation-a', limit: 101 }),
      ).rejects.toThrow();
    });

    test('uninstall atomically removes secrets, cancels pending work, and is idempotent', async () => {
      const { installations, credentials, database } = await factory.create();
      await installations.upsert(installation());
      await credentials.set(
        'installation-a',
        'throttleApiKey',
        new Uint8Array([1, 2, 3]),
      );
      const insert =
        'INSERT INTO jobs (job_id, installation_id, payload_reference, attempt, status, scheduled_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
      for (const [id, status] of [
        ['pending-job', 'pending'],
        ['retry-job', 'retry'],
        ['done-job', 'completed'],
      ] as const)
        await database
          .prepare(insert)
          .bind(
            id,
            'installation-a',
            `ref-${id}`,
            0,
            status,
            '2026-07-19T12:00:00.000Z',
            '2026-07-19T12:00:00.000Z',
            '2026-07-19T12:00:00.000Z',
          )
          .run();
      const when = new Date('2026-07-19T15:00:00.000Z');
      await installations.markUninstalled('installation-a', when);
      await installations.markUninstalled(
        'installation-a',
        new Date('2026-07-19T16:00:00.000Z'),
      );
      expect(await installations.get('installation-a')).toEqual(
        installation({
          status: 'uninstalled',
          updatedAt: when.toISOString(),
          uninstalledAt: when.toISOString(),
        }),
      );
      expect(
        await credentials.get('installation-a', 'throttleApiKey'),
      ).toBeUndefined();
      expect(
        (
          await database
            .prepare('SELECT status FROM jobs WHERE job_id = ?')
            .bind('pending-job')
            .first<{ status: string }>()
        )?.status,
      ).toBe('cancelled');
      expect(
        (
          await database
            .prepare('SELECT status FROM jobs WHERE job_id = ?')
            .bind('retry-job')
            .first<{ status: string }>()
        )?.status,
      ).toBe('cancelled');
      expect(
        (
          await database
            .prepare('SELECT status FROM jobs WHERE job_id = ?')
            .bind('done-job')
            .first<{ status: string }>()
        )?.status,
      ).toBe('completed');
    });
  });
}
