import { describe, expect, test, vi } from 'vitest';
import type { Activity, ConnectorJob, Installation } from '@starter/contracts';
import {
  connectorIdempotencyKey,
  processConnectorEvent,
} from './process-event.js';
import type { ProcessConnectorEventDependencies } from './process-event.js';
import {
  InfrastructureError,
  RetryableProviderError,
  TerminalProviderError,
} from './errors.js';
import { MAX_JOB_ATTEMPTS } from './retry.js';

const install: Installation = {
  installationId: 'i',
  workspaceId: 'w',
  applicationId: 'a',
  environmentId: 'e',
  environmentKind: 'non_production',
  extensionVersion: '1',
  status: 'active',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
};
const job: ConnectorJob = {
  jobId: 'j',
  installationId: 'i',
  createdAt: '2026-07-19T00:00:00.000Z',
  event: {
    id: 'evt',
    type: 'order.created',
    workspaceId: 'w',
    environmentId: 'e',
    createdAt: '2026-07-19T00:00:00.000Z',
    data: { orderId: 'o' },
  },
};
function setup(
  handleEvent: ProcessConnectorEventDependencies['connector']['handleEvent'] = vi.fn(
    async () => undefined,
  ),
) {
  let current: Installation | undefined = install;
  const activities: Activity[] = [];
  const deps: ProcessConnectorEventDependencies = {
    installations: {
      get: vi.fn(),
      getForJob: vi.fn(async () => current),
      upsert: vi.fn(),
      markUninstalled: vi.fn(),
      findWebhookVerificationCandidates: vi.fn(async () => []),
      updateProviderAccountReference: vi.fn(),
    },
    credentials: {
      get: vi.fn(async () => new TextEncoder().encode('secret')),
      set: vi.fn(),
      delete: vi.fn(),
    },
    configurations: {
      get: vi.fn(async () => ({ mode: 'normal' })),
      set: vi.fn(),
    },
    activities: {
      append: vi.fn(async (a) => {
        if (!activities.some((x) => x.activityId === a.activityId))
          activities.push(a);
      }),
      list: vi.fn(async () => []),
    },
    executions: {
      claim: vi.fn(async () => ({
        status: 'claimed' as const,
        token: 'claim-token',
        attempt: 1,
      })),
      finish: vi.fn(async (input) => {
        if (
          !activities.some(
            (item) => item.activityId === input.activity.activityId,
          )
        )
          activities.push(input.activity);
        return 'finished' as const;
      }),
    },
    connector: { validateCredentials: vi.fn(), handleEvent },
    clock: { now: () => new Date('2026-07-19T01:00:00.000Z') },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return {
    deps,
    activities,
    setInstallation: (value: Installation | undefined) => {
      current = value;
    },
  };
}
describe('processConnectorEvent', () => {
  test('processes an accepted active scoped job and records one successful attempt', async () => {
    const f = setup();
    expect(await processConnectorEvent(job, f.deps)).toEqual({
      status: 'success',
    });
    expect(f.deps.connector.handleEvent).toHaveBeenCalledOnce();
    expect(f.deps.connector.handleEvent).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: '["i","evt"]' }),
    );
    expect(f.deps.executions.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'j',
        attempt: 1,
        status: 'completed',
        token: 'claim-token',
        activity: expect.objectContaining({
          activityId: 'j:1',
          result: 'success',
        }),
      }),
    );
    expect(
      JSON.stringify(
        (f.deps.connector.handleEvent as ReturnType<typeof vi.fn>).mock.calls,
      ),
    ).not.toContain('claim-token');
    expect(JSON.stringify(f.activities)).not.toContain('claim-token');
    expect(
      JSON.stringify(
        (f.deps.logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ),
    ).not.toContain('claim-token');
    expect(f.activities).toMatchObject([
      {
        activityId: 'j:1',
        installationId: 'i',
        jobId: 'j',
        eventId: 'evt',
        status: 'completed',
        result: 'success',
        attempt: 1,
      },
    ]);
  });
  test('duplicate claim is a successful no-op with no provider or activity', async () => {
    const f = setup();
    (f.deps.executions.claim as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'duplicate',
    });
    expect(await processConnectorEvent(job, f.deps)).toEqual({
      status: 'success',
    });
    expect(f.deps.connector.handleEvent).not.toHaveBeenCalled();
    expect(f.activities).toHaveLength(0);
  });
  test.each([1, 300])(
    'retries a busy live lease after bounded delay %i without side effects',
    async (retryAfterSeconds) => {
      const f = setup();
      (f.deps.executions.claim as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'busy',
        retryAfterSeconds,
      });
      expect(await processConnectorEvent(job, f.deps)).toEqual({
        status: 'retry',
        code: 'JOB_BUSY',
        delaySeconds: retryAfterSeconds,
      });
      expect(f.deps.connector.handleEvent).not.toHaveBeenCalled();
      expect(f.activities).toHaveLength(0);
      expect(f.deps.executions.finish).not.toHaveBeenCalled();
    },
  );
  test('uses the same provider idempotency key across attempts', async () => {
    const keys: string[] = [];
    const f = setup(
      vi.fn(async (input) => {
        keys.push(input.idempotencyKey);
      }),
    );
    await processConnectorEvent(job, f.deps);
    (f.deps.executions.claim as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'claimed',
      token: 'claim-token-2',
      attempt: 2,
    });
    await processConnectorEvent(job, f.deps);
    expect(keys).toEqual(['["i","evt"]', '["i","evt"]']);
  });
  test('namespaces equal event IDs by installation without delimiter ambiguity', () => {
    expect(connectorIdempotencyKey('installation-a', 'same-event')).not.toBe(
      connectorIdempotencyKey('installation-b', 'same-event'),
    );
    expect(connectorIdempotencyKey('a:b', 'c')).not.toBe(
      connectorIdempotencyKey('a', 'b:c'),
    );
  });
  test('does not requeue when uninstall cancels a claimed job during provider work', async () => {
    const f = setup(
      vi.fn(async () => {
        throw new RetryableProviderError();
      }),
    );
    (f.deps.executions.finish as ReturnType<typeof vi.fn>).mockResolvedValue(
      'cancelled',
    );
    expect(await processConnectorEvent(job, f.deps)).toEqual({
      status: 'terminal',
      code: 'JOB_CANCELLED',
    });
    expect(f.deps.executions.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'retry' }),
    );
  });
  test('redelivery after atomic finish failure reuses the stable provider key', async () => {
    const keys: string[] = [];
    const f = setup(
      vi.fn(async (input) => {
        keys.push(input.idempotencyKey);
      }),
    );
    (f.deps.executions.finish as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('activity unavailable'))
      .mockResolvedValue('finished');
    await expect(processConnectorEvent(job, f.deps)).rejects.toThrow(
      'activity unavailable',
    );
    expect(await processConnectorEvent(job, f.deps)).toEqual({
      status: 'success',
    });
    expect(keys).toEqual(['["i","evt"]', '["i","evt"]']);
    expect(f.deps.executions.finish).toHaveBeenCalledTimes(2);
  });
  test('wipes the credential buffer returned by the store', async () => {
    const f = setup();
    const returned = new TextEncoder().encode('secret');
    (f.deps.credentials.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      returned,
    );
    await processConnectorEvent(job, f.deps);
    expect(returned).toEqual(new Uint8Array(6));
  });
  test('treats programmer errors as safe terminal failures', async () => {
    const f = setup(
      vi.fn(async () => {
        throw new TypeError('secret raw');
      }),
    );
    expect(await processConnectorEvent(job, f.deps)).toEqual({
      status: 'terminal',
      code: 'UNEXPECTED_ERROR',
    });
  });
  test.each(['pending', 'disconnected', 'uninstalled'] as const)(
    'rejects %s state without provider work',
    async (status) => {
      const f = setup();
      f.setInstallation(
        status === 'uninstalled'
          ? { ...install, status, uninstalledAt: '2026-07-19T00:30:00.000Z' }
          : { ...install, status },
      );
      expect(await processConnectorEvent(job, f.deps)).toEqual({
        status: 'terminal',
        code: 'INSTALLATION_INACTIVE',
      });
      expect(f.deps.connector.handleEvent).not.toHaveBeenCalled();
    },
  );
  test('rejects an installation or environment mismatch', async () => {
    const f = setup();
    f.setInstallation({ ...install, environmentId: 'other' });
    expect(await processConnectorEvent(job, f.deps)).toEqual({
      status: 'terminal',
      code: 'INSTALLATION_SCOPE_MISMATCH',
    });
    expect(f.deps.connector.handleEvent).not.toHaveBeenCalled();
  });
  test.each([
    ['configuration', undefined],
    ['credential', null],
  ] as const)(
    'returns actionable terminal result for missing %s',
    async (kind, value) => {
      const f = setup();
      if (kind === 'configuration')
        (
          f.deps.configurations.get as ReturnType<typeof vi.fn>
        ).mockResolvedValue(value);
      else
        (f.deps.credentials.get as ReturnType<typeof vi.fn>).mockResolvedValue(
          undefined,
        );
      expect(await processConnectorEvent(job, f.deps)).toEqual({
        status: 'terminal',
        code:
          kind === 'configuration'
            ? 'CONFIGURATION_MISSING'
            : 'CREDENTIAL_MISSING',
      });
    },
  );
  test.each([
    [1, 5],
    [4, 625],
  ])(
    'maps retryable provider errors on attempt %i to bounded retry',
    async (attempt, delaySeconds) => {
      const f = setup(
        vi.fn(async () => {
          throw new RetryableProviderError();
        }),
      );
      (f.deps.executions.claim as ReturnType<typeof vi.fn>).mockResolvedValue({
        status: 'claimed',
        token: 'claim-token',
        attempt,
      });
      expect(await processConnectorEvent(job, f.deps)).toEqual({
        status: 'retry',
        delaySeconds,
        code: 'RETRYABLE_PROVIDER_ERROR',
      });
      expect(f.deps.executions.finish).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'retry',
          nextEligibleAt: new Date(
            new Date('2026-07-19T01:00:00.000Z').valueOf() +
              delaySeconds * 1000,
          ),
        }),
      );
    },
  );
  test('maps terminal provider errors without exposing their causes', async () => {
    const f = setup(
      vi.fn(async () => {
        throw new TerminalProviderError({
          cause: { body: 'credential=secret' },
        });
      }),
    );
    expect(await processConnectorEvent(job, f.deps)).toEqual({
      status: 'terminal',
      code: 'TERMINAL_PROVIDER_ERROR',
    });
    expect(JSON.stringify(f.activities)).not.toContain('secret');
  });
  test('retries explicit infrastructure errors, then exhausts', async () => {
    const f = setup(
      vi.fn(async () => {
        throw new InfrastructureError({ cause: 'raw provider body secret' });
      }),
    );
    expect(await processConnectorEvent(job, f.deps)).toEqual({
      status: 'retry',
      delaySeconds: 5,
      code: 'INFRASTRUCTURE_ERROR',
    });
    expect(
      await (async () => {
        (f.deps.executions.claim as ReturnType<typeof vi.fn>).mockResolvedValue(
          {
            status: 'claimed',
            token: 'claim-token-5',
            attempt: MAX_JOB_ATTEMPTS,
          },
        );
        return processConnectorEvent(job, f.deps);
      })(),
    ).toEqual({ status: 'terminal', code: 'ATTEMPTS_EXHAUSTED' });
    expect(JSON.stringify(f.activities)).not.toContain('raw provider');
  });
  test('executes attempt five but exhausts a retryable result', async () => {
    const f = setup(
      vi.fn(async () => {
        throw new RetryableProviderError();
      }),
    );
    (f.deps.executions.claim as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'claimed',
      token: 'claim-token',
      attempt: 5,
    });
    expect(await processConnectorEvent(job, f.deps)).toEqual({
      status: 'terminal',
      code: 'ATTEMPTS_EXHAUSTED',
    });
    expect(f.deps.connector.handleEvent).toHaveBeenCalledOnce();
  });
  test('rejects attempt six before any lookup, configuration, credential, or provider work', async () => {
    const f = setup(vi.fn(async () => undefined));
    (f.deps.executions.claim as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'claimed',
      token: 'claim-token',
      attempt: 6,
    });
    expect(await processConnectorEvent(job, f.deps)).toEqual({
      status: 'terminal',
      code: 'ATTEMPTS_EXHAUSTED',
    });
    expect(f.deps.installations.getForJob).not.toHaveBeenCalled();
    expect(f.deps.configurations.get).not.toHaveBeenCalled();
    expect(f.deps.credentials.get).not.toHaveBeenCalled();
    expect(f.deps.connector.handleEvent).not.toHaveBeenCalled();
    expect(f.deps.executions.finish).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 6, status: 'failed' }),
    );
    expect(f.activities).toMatchObject([
      {
        activityId: 'j:6',
        attempt: 6,
        result: 'terminal_failure',
        code: 'ATTEMPTS_EXHAUSTED',
      },
    ]);
  });
  test('records a duplicate execution attempt idempotently', async () => {
    const f = setup();
    await processConnectorEvent(job, f.deps);
    await processConnectorEvent(job, f.deps);
    expect(f.activities).toHaveLength(1);
  });
});
