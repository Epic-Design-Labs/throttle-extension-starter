import { expect, test, vi } from 'vitest';
import { InstallationBootstrapError } from '@starter/adapters-d1';
import { createQueueEntrypoint, mapBootstrapError } from './index.js';

const event = {
  id: 'event-1',
  type: 'order.created',
  workspaceId: 'workspace-1',
  environmentId: 'environment-1',
  createdAt: '2026-07-19T10:00:00.000Z',
  data: { orderId: 'order-1' },
};

test('production queue entrypoint delegates every message independently', async () => {
  const process = vi.fn(async () => ({ status: 'success' as const }));
  const ack1 = vi.fn();
  const ack2 = vi.fn();
  const queue = createQueueEntrypoint({
    processConnectorEvent: process,
    recordFailure: vi.fn(async () => undefined),
    maxDeliveryAttempts: 5,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  await queue({
    messages: [
      {
        id: 'm1',
        attempts: 1,
        body: {
          version: 1,
          job: {
            jobId: 'job-1',
            installationId: 'install-1',
            event,
            createdAt: event.createdAt,
          },
        },
        ack: ack1,
        retry: vi.fn(),
      },
      {
        id: 'm2',
        attempts: 1,
        body: {
          version: 1,
          job: {
            jobId: 'job-2',
            installationId: 'install-1',
            event: { ...event, id: 'event-2' },
            createdAt: event.createdAt,
          },
        },
        ack: ack2,
        retry: vi.fn(),
      },
    ],
  });
  expect(process).toHaveBeenCalledTimes(2);
  expect(ack1).toHaveBeenCalledOnce();
  expect(ack2).toHaveBeenCalledOnce();
});

test.each([
  ['replace_required', 409, 'ROTATION_CONFIRMATION_REQUIRED'],
  ['target_not_found', 409, 'ROTATION_TARGET_NOT_FOUND'],
  ['scope_conflict', 403, 'INSTALLATION_SCOPE_CONFLICT'],
] as const)(
  'maps bootstrap %s to a stable response',
  (reason, status, code) => {
    const mapped = mapBootstrapError(new InstallationBootstrapError(reason));
    expect(mapped).toMatchObject({ status, code });
  },
);
