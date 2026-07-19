import type { Activity, Installation } from '@starter/contracts';
import {
  installationSchema,
  MAX_WEBHOOK_VERIFICATION_CANDIDATES,
} from '@starter/contracts';
import type {
  ActivityStore,
  CredentialKind,
  CredentialStore,
  DeliveryStore,
  InstallationScope,
  InstallationStore,
} from './ports.js';

type TestFn = (name: string, callback: () => Promise<void>) => void;
type Expect = (actual: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeUndefined(): void;
  toHaveLength(expected: number): void;
  rejects: { toThrow(expected?: unknown): Promise<void> };
};

export interface StoredSecretInspection {
  algorithm: string;
  keyVersion: number;
  iv: string;
  ciphertext: string;
  containsPlaintext: boolean;
}
export interface PersistenceAdapterFixture {
  installations: InstallationStore;
  credentials: CredentialStore;
  deliveries: DeliveryStore;
  activities: ActivityStore;
  inspectStoredSecret(
    installationId: string,
    kind: CredentialKind,
  ): Promise<StoredSecretInspection | undefined>;
  copyStoredSecretToInstallation(
    sourceInstallationId: string,
    targetInstallationId: string,
    kind: CredentialKind,
  ): Promise<void>;
  seedJob(input: {
    jobId: string;
    installationId: string;
    status: 'pending' | 'retry' | 'completed';
  }): Promise<void>;
  getJobStatus(jobId: string): Promise<string | undefined>;
  setJobStatus(
    jobId: string,
    status: 'pending' | 'retry' | 'processing',
  ): Promise<void>;
  rotateCredentialKey(version: number, key: Uint8Array): void;
  removeCredentialKey(version: number): void;
  cleanup(): Promise<void>;
}
export interface PersistenceAdapterContractFactory {
  describe(name: string, callback: () => void): void;
  test: TestFn;
  expect: Expect;
  create(): Promise<PersistenceAdapterFixture>;
}

const installation = (overrides: Partial<Installation> = {}): Installation =>
  installationSchema.parse({
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
const scope = (
  overrides: Partial<InstallationScope> = {},
): InstallationScope => ({
  workspaceId: 'workspace-a',
  applicationId: 'application-a',
  environmentId: 'environment-a',
  ...overrides,
});

export function runPersistenceAdapterContract(
  factory: PersistenceAdapterContractFactory,
): void {
  const { describe, test, expect } = factory;
  describe('persistence adapter contract', () => {
    test('round-trips strict installations and upserts replacements', async () => {
      const fixture = await factory.create();
      const { installations } = fixture;
      const original = installation();
      expect(await installations.upsert(original)).toEqual(original);
      const replacement = installation({
        extensionVersion: '2.0.0',
        updatedAt: '2026-07-19T11:00:00.000Z',
      });
      expect(await installations.upsert(replacement)).toEqual(replacement);
      expect(await installations.get(original.installationId, scope())).toEqual(
        replacement,
      );
      expect(await installations.get('missing', scope())).toBeUndefined();
      await fixture.cleanup();
    });

    test('preserves installation identity and creation time on upsert collisions', async () => {
      const fixture = await factory.create();
      const { installations } = fixture;
      await installations.upsert(installation());
      for (const collision of [
        installation({ workspaceId: 'wrong' }),
        installation({ applicationId: 'wrong' }),
        installation({ environmentId: 'wrong' }),
        installation({ createdAt: '2026-07-20T10:00:00.000Z' }),
      ])
        await expect(installations.upsert(collision)).rejects.toThrow();
      expect(await installations.get('installation-a', scope())).toEqual(
        installation(),
      );
      await fixture.cleanup();
    });

    test('requires exact workspace, application, and environment scope for ordinary reads', async () => {
      const fixture = await factory.create();
      const { installations } = fixture;
      await installations.upsert(installation());
      expect(await installations.get('installation-a', scope())).toEqual(
        installation(),
      );
      expect(
        await installations.get(
          'installation-a',
          scope({ workspaceId: 'wrong' }),
        ),
      ).toBeUndefined();
      expect(
        await installations.get(
          'installation-a',
          scope({ applicationId: 'wrong' }),
        ),
      ).toBeUndefined();
      expect(
        await installations.get(
          'installation-a',
          scope({ environmentId: 'wrong' }),
        ),
      ).toBeUndefined();
      await fixture.cleanup();
    });

    test('webhook candidates use only workspace/environment, are narrow, and cap at the shared maximum', async () => {
      const fixture = await factory.create();
      const { installations } = fixture;
      await Promise.all(
        Array.from(
          { length: MAX_WEBHOOK_VERIFICATION_CANDIDATES + 5 },
          (_, index) =>
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
      expect(candidates).toHaveLength(MAX_WEBHOOK_VERIFICATION_CANDIDATES);
      expect(
        candidates.every(
          (candidate) =>
            Object.keys(candidate).length === 1 &&
            typeof candidate.installationId === 'string',
        ),
      ).toBe(true);
      expect(
        candidates.some(
          ({ installationId }) =>
            installationId === 'wrong-workspace' ||
            installationId === 'wrong-environment',
        ),
      ).toBe(false);
      await fixture.cleanup();
    });

    test('sets, replaces, gets and deletes encrypted credentials by installation and kind', async () => {
      const fixture = await factory.create();
      const { installations, credentials } = fixture;
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
      const stored = await fixture.inspectStoredSecret(
        'installation-a',
        'providerCredentials',
      );
      expect(stored?.algorithm).toBe('A256GCM');
      expect((stored?.keyVersion ?? 0) > 0).toBe(true);
      expect((stored?.iv.length ?? 0) > 0).toBe(true);
      expect((stored?.ciphertext.length ?? 0) > 0).toBe(true);
      expect(stored?.ciphertext === 'first secret').toBe(false);
      expect(stored?.containsPlaintext).toBe(false);
      await fixture.copyStoredSecretToInstallation(
        'installation-a',
        'installation-b',
        'providerCredentials',
      );
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
      await fixture.cleanup();
    });

    test('reads retained old credential keys and writes with the rotated current key', async () => {
      const fixture = await factory.create();
      await fixture.installations.upsert(installation());
      await fixture.credentials.set(
        'installation-a',
        'providerCredentials',
        new TextEncoder().encode('old'),
      );
      fixture.rotateCredentialKey(4, new Uint8Array(32).fill(9));
      expect(
        new TextDecoder().decode(
          await fixture.credentials.get(
            'installation-a',
            'providerCredentials',
          ),
        ),
      ).toBe('old');
      await fixture.credentials.set(
        'installation-a',
        'webhookSigningSecret',
        new TextEncoder().encode('new'),
      );
      expect(
        (
          await fixture.inspectStoredSecret(
            'installation-a',
            'webhookSigningSecret',
          )
        )?.keyVersion,
      ).toBe(4);
      fixture.removeCredentialKey(3);
      await expect(
        fixture.credentials.get('installation-a', 'providerCredentials'),
      ).rejects.toThrow();
      expect(
        new TextDecoder().decode(
          await fixture.credentials.get(
            'installation-a',
            'webhookSigningSecret',
          ),
        ),
      ).toBe('new');
      await fixture.cleanup();
    });

    test('accepts exactly one of two concurrent duplicate deliveries', async () => {
      const fixture = await factory.create();
      await fixture.installations.upsert(installation());
      const input = {
        installationId: 'installation-a',
        eventId: 'event-a',
        eventType: 'order.created',
        acceptedAt: new Date('2026-07-19T12:00:00.000Z'),
      };
      const results = await Promise.all([
        fixture.deliveries.accept(input),
        fixture.deliveries.accept(input),
      ]);
      expect(results.filter(({ accepted }) => accepted)).toHaveLength(1);
      expect(results.filter(({ accepted }) => !accepted)).toHaveLength(1);
      await fixture.cleanup();
    });

    test('lists bounded activity newest-first with stable id tie-break and installation isolation', async () => {
      const fixture = await factory.create();
      const { installations, activities } = fixture;
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
      await fixture.cleanup();
    });

    test('scoped uninstall is atomic, idempotent, and cannot mutate another tenant', async () => {
      const fixture = await factory.create();
      const { installations, credentials } = fixture;
      await installations.upsert(installation());
      await credentials.set(
        'installation-a',
        'throttleApiKey',
        new Uint8Array([1, 2, 3]),
      );
      await fixture.seedJob({
        jobId: 'pending-job',
        installationId: 'installation-a',
        status: 'pending',
      });
      await fixture.seedJob({
        jobId: 'retry-job',
        installationId: 'installation-a',
        status: 'retry',
      });
      await fixture.seedJob({
        jobId: 'done-job',
        installationId: 'installation-a',
        status: 'completed',
      });
      const when = new Date('2026-07-19T15:00:00.000Z');
      await installations.markUninstalled(
        'installation-a',
        scope({ applicationId: 'wrong' }),
        when,
      );
      expect((await installations.get('installation-a', scope()))?.status).toBe(
        'active',
      );
      expect(await credentials.get('installation-a', 'throttleApiKey')).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      await installations.markUninstalled('installation-a', scope(), when);
      await installations.markUninstalled(
        'installation-a',
        scope(),
        new Date('2026-07-19T16:00:00.000Z'),
      );
      expect(await installations.get('installation-a', scope())).toEqual(
        installation({
          status: 'uninstalled',
          updatedAt: when.toISOString(),
          uninstalledAt: when.toISOString(),
        }),
      );
      expect(
        await credentials.get('installation-a', 'throttleApiKey'),
      ).toBeUndefined();
      expect(await fixture.getJobStatus('pending-job')).toBe('cancelled');
      expect(await fixture.getJobStatus('retry-job')).toBe('cancelled');
      expect(await fixture.getJobStatus('done-job')).toBe('completed');
      await expect(
        credentials.set(
          'installation-a',
          'throttleApiKey',
          new Uint8Array([9]),
        ),
      ).rejects.toThrow();
      await expect(
        fixture.seedJob({
          jobId: 'late-job',
          installationId: 'installation-a',
          status: 'pending',
        }),
      ).rejects.toThrow();
      await expect(fixture.setJobStatus('done-job', 'retry')).rejects.toThrow();
      await expect(
        installations.upsert(
          installation({ updatedAt: '2026-07-20T00:00:00.000Z' }),
        ),
      ).rejects.toThrow();
      expect((await installations.get('installation-a', scope()))?.status).toBe(
        'uninstalled',
      );
      await fixture.cleanup();
    });

    test('concurrent uninstall and credential write cannot leave a secret behind', async () => {
      const fixture = await factory.create();
      await fixture.installations.upsert(installation());
      await Promise.allSettled([
        fixture.installations.markUninstalled(
          'installation-a',
          scope(),
          new Date('2026-07-19T15:00:00.000Z'),
        ),
        fixture.credentials.set(
          'installation-a',
          'providerCredentials',
          new TextEncoder().encode('racing-secret'),
        ),
      ]);
      expect(
        (await fixture.installations.get('installation-a', scope()))?.status,
      ).toBe('uninstalled');
      expect(
        await fixture.credentials.get('installation-a', 'providerCredentials'),
      ).toBeUndefined();
      await fixture.cleanup();
    });
  });
}
