import { describe, expect, test, vi } from 'vitest';
import type { Installation } from '@starter/contracts';
import { AuthorizationError, TerminalProviderError } from './errors.js';
import { connectProvider } from './connect-provider.js';
import type { ConnectProviderDependencies } from './connect-provider.js';

const installation: Installation = {
  installationId: 'install-1',
  workspaceId: 'workspace-1',
  applicationId: 'app-1',
  environmentId: 'env-1',
  environmentKind: 'non_production',
  extensionVersion: '1',
  status: 'active',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
};

function setup(overrides: Partial<ConnectProviderDependencies> = {}) {
  let saved = new Uint8Array([9]);
  let current = installation;
  const calls: string[] = [];
  const dependencies: ConnectProviderDependencies = {
    installations: {
      get: vi.fn(async () => current),
      getForJob: vi.fn(async () => current),
      upsert: vi.fn(),
      markUninstalled: vi.fn(),
      findWebhookVerificationCandidates: vi.fn(async () => []),
      updateProviderAccountReference: vi.fn(
        async (_id, _scope, reference, at) => {
          calls.push('installation');
          current = {
            ...current,
            providerAccountReference: reference,
            updatedAt: at.toISOString(),
          };
          return current;
        },
      ),
    },
    credentials: {
      get: vi.fn(async () => saved),
      set: vi.fn(async (_id, _kind, bytes) => {
        calls.push('credential');
        saved = new Uint8Array(bytes);
      }),
      delete: vi.fn(),
    },
    activities: {
      append: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    },
    connector: {
      validateCredentials: vi.fn(async (bytes) => {
        calls.push('validate');
        expect(new TextDecoder().decode(bytes)).toBe('valid-secret');
        return { providerAccountReference: 'provider-account' };
      }),
      handleEvent: vi.fn(),
    },
    clock: { now: () => new Date('2026-07-19T01:00:00.000Z') },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return {
    dependencies,
    calls,
    saved: () => saved,
    setInstallation: (next: Installation) => {
      current = next;
    },
  };
}

describe('connectProvider', () => {
  test('validates owned credential bytes before storing and updates only the provider account reference', async () => {
    let validationReference: Uint8Array | undefined;
    let storageReference: Uint8Array | undefined;
    const fixture = setup({
      connector: {
        validateCredentials: vi.fn(async (bytes) => {
          validationReference = bytes;
          return { providerAccountReference: 'provider-account' };
        }),
        handleEvent: vi.fn(),
      },
      credentials: {
        get: vi.fn(),
        set: vi.fn(async (_id, _kind, bytes) => {
          storageReference = bytes;
          expect(bytes).not.toBe(validationReference);
        }),
        delete: vi.fn(),
      },
    });
    const caller = new TextEncoder().encode('valid-secret');
    const result = await connectProvider(
      {
        installationId: 'install-1',
        scope: {
          workspaceId: 'workspace-1',
          applicationId: 'app-1',
          environmentId: 'env-1',
        },
        credentials: caller,
      },
      fixture.dependencies,
    );
    expect(validationReference).not.toBe(caller);
    expect(storageReference).not.toBe(caller);
    expect(validationReference).not.toBe(storageReference);
    expect(validationReference).toEqual(new Uint8Array('valid-secret'.length));
    expect(storageReference).toEqual(new Uint8Array('valid-secret'.length));
    expect(fixture.calls).toEqual(['installation']);
    expect(new TextDecoder().decode(caller)).toBe('valid-secret');
    expect(result.providerAccountReference).toBe('provider-account');
    expect(result.workspaceId).toBe('workspace-1');
    expect(fixture.dependencies.activities.append).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: 'install-1',
        type: 'connector_sync',
        result: 'success',
        code: 'PROVIDER_CONNECTED',
      }),
    );
    expect(fixture.dependencies.logger.info).toHaveBeenCalledWith(
      'Provider connected',
      {
        installationId: 'install-1',
        providerAccountReference: 'provider-account',
      },
    );
  });

  test('does not overwrite a prior credential when validation rejects', async () => {
    const fixture = setup({
      connector: {
        validateCredentials: vi.fn(async () => {
          throw new TerminalProviderError();
        }),
        handleEvent: vi.fn(),
      },
    });
    await expect(
      connectProvider(
        {
          installationId: 'install-1',
          scope: {
            workspaceId: 'workspace-1',
            applicationId: 'app-1',
            environmentId: 'env-1',
          },
          credentials: new TextEncoder().encode('expired'),
        },
        fixture.dependencies,
      ),
    ).rejects.toBeInstanceOf(TerminalProviderError);
    expect(fixture.saved()).toEqual(new Uint8Array([9]));
    expect(fixture.dependencies.credentials.set).not.toHaveBeenCalled();
    expect(
      JSON.stringify(
        (fixture.dependencies.logger.error as ReturnType<typeof vi.fn>).mock
          .calls,
      ),
    ).not.toContain('expired');
    expect(
      JSON.stringify(
        (fixture.dependencies.activities.append as ReturnType<typeof vi.fn>)
          .mock.calls,
      ),
    ).not.toContain('expired');
  });

  test('rejects a malformed validation response before storage', async () => {
    const fixture = setup({
      connector: {
        validateCredentials: vi.fn(async () => ({
          providerAccountReference: '',
        })),
        handleEvent: vi.fn(),
      },
    });
    await expect(
      connectProvider(
        {
          installationId: 'install-1',
          scope: {
            workspaceId: 'workspace-1',
            applicationId: 'app-1',
            environmentId: 'env-1',
          },
          credentials: new Uint8Array([1]),
        },
        fixture.dependencies,
      ),
    ).rejects.toThrow();
    expect(fixture.dependencies.credentials.set).not.toHaveBeenCalled();
  });

  test.each(['pending', 'disconnected', 'uninstalled'] as const)(
    'rejects a %s installation',
    async (status) => {
      const fixture = setup();
      fixture.setInstallation(
        status === 'uninstalled'
          ? {
              ...installation,
              status,
              uninstalledAt: '2026-07-19T00:30:00.000Z',
            }
          : { ...installation, status },
      );
      await expect(
        connectProvider(
          {
            installationId: 'install-1',
            scope: {
              workspaceId: 'workspace-1',
              applicationId: 'app-1',
              environmentId: 'env-1',
            },
            credentials: new Uint8Array([1]),
          },
          fixture.dependencies,
        ),
      ).rejects.toBeInstanceOf(AuthorizationError);
      expect(
        fixture.dependencies.connector.validateCredentials,
      ).not.toHaveBeenCalled();
    },
  );

  test('rejects a mismatched authenticated scope', async () => {
    const fixture = setup();
    (
      fixture.dependencies.installations.get as ReturnType<typeof vi.fn>
    ).mockResolvedValue(undefined);
    await expect(
      connectProvider(
        {
          installationId: 'install-1',
          scope: {
            workspaceId: 'other',
            applicationId: 'app-1',
            environmentId: 'env-1',
          },
          credentials: new Uint8Array([1]),
        },
        fixture.dependencies,
      ),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });
});
