import { describe, expect, test, vi } from 'vitest';
import type { ConnectorJob } from '@starter/contracts';
import {
  CONNECTOR_QUEUE_PAYLOAD_VERSION,
  MAX_QUEUE_PAYLOAD_BYTES,
  consumeConnectorQueue,
  createCloudflareQueueProducer,
  createActivityStoreQueueFailureRecorder,
} from './index.js';

const job: ConnectorJob = {
  jobId: 'job-1',
  installationId: 'installation-1',
  createdAt: '2026-07-19T00:00:00.000Z',
  event: {
    id: 'event-1',
    type: 'order.created',
    workspaceId: 'workspace-1',
    environmentId: 'environment-1',
    createdAt: '2026-07-19T00:00:00.000Z',
    data: { orderId: 'order-1' },
  },
};

function message(body: unknown, attempts = 1) {
  return {
    id: `message-${attempts}`,
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe('Cloudflare queue producer', () => {
  test('sends the exact stable, identifier-and-event-only payload', async () => {
    const queue = { send: vi.fn(async () => undefined) };
    await createCloudflareQueueProducer(queue).enqueue(job);
    expect(queue.send).toHaveBeenCalledWith(
      {
        version: CONNECTOR_QUEUE_PAYLOAD_VERSION,
        job,
      },
      { contentType: 'json' },
    );
    expect(JSON.stringify(queue.send.mock.calls)).not.toMatch(
      /credential|secret|ciphertext|token/iu,
    );
  });

  test.each(['credentials', 'accessToken', 'ciphertext', 'configuration'])(
    'rejects secret-bearing or configuration field %s before send',
    async (field) => {
      const queue = { send: vi.fn(async () => undefined) };
      await expect(
        createCloudflareQueueProducer(queue).enqueue({
          ...job,
          [field]: 'do-not-send',
        }),
      ).rejects.toThrow();
      expect(queue.send).not.toHaveBeenCalled();
    },
  );

  test('accepts the conservative serialized JSON byte budget exactly', async () => {
    const queue = { send: vi.fn(async () => ({ outcome: 'ok' })) };
    const exact = jobWithSerializedBytes(MAX_QUEUE_PAYLOAD_BYTES);
    await createCloudflareQueueProducer(queue).enqueue(exact);
    expect(serializedBytes(exact)).toBe(MAX_QUEUE_PAYLOAD_BYTES);
    expect(queue.send).toHaveBeenCalledOnce();
  });

  test.each([MAX_QUEUE_PAYLOAD_BYTES + 1, 127_999])(
    'rejects serialized JSON payload of %i bytes before send',
    async (bytes) => {
      const queue = { send: vi.fn(async () => undefined) };
      const oversized = jobWithSerializedBytes(bytes);
      expect(serializedBytes(oversized)).toBe(bytes);
      await expect(
        createCloudflareQueueProducer(queue).enqueue(oversized),
      ).rejects.toThrow(/payload.*large/iu);
      expect(queue.send).not.toHaveBeenCalled();
    },
  );

  test('rejects malformed and non-cloneable inputs before send', async () => {
    const queue = { send: vi.fn(async () => undefined) };
    for (const invalid of [
      { ...job, event: { ...job.event, data: { value: () => undefined } } },
      { ...job, createdAt: 'yesterday' },
    ])
      await expect(
        createCloudflareQueueProducer(queue).enqueue(invalid as ConnectorJob),
      ).rejects.toThrow();
    expect(queue.send).not.toHaveBeenCalled();
  });
});

describe('Cloudflare queue consumer', () => {
  const body = { version: CONNECTOR_QUEUE_PAYLOAD_VERSION, job };

  test.each([
    { status: 'success' as const },
    { status: 'terminal' as const, code: 'INSTALLATION_INACTIVE' },
  ])('acks $status results exactly once', async (result) => {
    const item = message(body);
    await consumeConnectorQueue(
      { messages: [item] },
      consumerDependencies(vi.fn(async () => result)),
    );
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
  });

  test.each([
    ['JOB_BUSY', 17],
    ['RETRYABLE_PROVIDER_ERROR', 625],
  ])(
    'retries %s once with bounded integer delay',
    async (code, delaySeconds) => {
      const item = message(body, 99);
      await consumeConnectorQueue(
        { messages: [item] },
        {
          processConnectorEvent: vi.fn(async () => ({
            status: 'retry' as const,
            code,
            delaySeconds,
          })),
          logger: logger(),
          recordFailure: vi.fn(),
          maxDeliveryAttempts: 5,
        },
      );
      expect(item.retry).toHaveBeenCalledOnce();
      expect(item.retry).toHaveBeenCalledWith({ delaySeconds });
      expect(item.ack).not.toHaveBeenCalled();
    },
  );

  test.each([0, -1, 1.5, 43_201])(
    'replaces invalid retry delay %s with a safe positive default',
    async (delaySeconds) => {
      const item = message(body);
      await consumeConnectorQueue(
        { messages: [item] },
        {
          processConnectorEvent: vi.fn(async () => ({
            status: 'retry' as const,
            code: 'INVALID_DELAY',
            delaySeconds,
          })),
          logger: logger(),
          recordFailure: vi.fn(),
          maxDeliveryAttempts: 5,
        },
      );
      expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    },
  );

  test('acks malformed messages without calling or logging their raw body', async () => {
    const item = message({ accessToken: 'raw-secret' });
    const log = logger();
    const process = vi.fn();
    await consumeConnectorQueue(
      { messages: [item] },
      consumerDependencies(process, { logger: log }),
    );
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(JSON.stringify(log)).not.toContain('raw-secret');
    expect(
      JSON.stringify(Object.values(log).flatMap((fn) => fn.mock.calls)),
    ).not.toContain('raw-secret');
  });

  test('isolates messages and retries unexpected processor throws', async () => {
    const first = message(body);
    const malformed = message(null);
    const third = message({ ...body, job: { ...job, jobId: 'job-3' } });
    const process = vi
      .fn()
      .mockRejectedValueOnce(new Error('credential=raw-secret'))
      .mockResolvedValueOnce({ status: 'success' });
    const log = logger();
    await consumeConnectorQueue(
      { messages: [first, malformed, third] },
      consumerDependencies(process, { logger: log }),
    );
    expect(first.retry).toHaveBeenCalledOnce();
    expect(first.ack).not.toHaveBeenCalled();
    expect(malformed.ack).toHaveBeenCalledOnce();
    expect(third.ack).toHaveBeenCalledOnce();
    expect(process).toHaveBeenCalledTimes(2);
    expect(
      JSON.stringify(Object.values(log).flatMap((fn) => fn.mock.calls)),
    ).not.toContain('raw-secret');
  });

  test('never retries a message after its ack was invoked', async () => {
    const item = message(body);
    item.ack.mockImplementation(() => {
      throw new Error('ack transport failed');
    });
    await expect(
      consumeConnectorQueue(
        { messages: [item] },
        {
          processConnectorEvent: vi.fn(async () => ({
            status: 'success' as const,
          })),
          logger: logger(),
          recordFailure: vi.fn(),
          maxDeliveryAttempts: 5,
        },
      ),
    ).rejects.toThrow('ack transport failed');
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
  });

  test('retries a structurally plausible future envelope without dropping it', async () => {
    const item = message({ version: 2, job });
    const process = vi.fn();
    await consumeConnectorQueue(
      { messages: [item] },
      consumerDependencies(process),
    );
    expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
    expect(item.ack).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
  });

  test('records a safe processor failure before retry and marks the final delivery terminal', async () => {
    const item = message(body, 3);
    const recorder = vi.fn(async () => undefined);
    const process = vi.fn(async () => {
      throw new Error('credential=raw-secret');
    });
    await consumeConnectorQueue(
      { messages: [item] },
      consumerDependencies(process, {
        recordFailure: recorder,
        maxDeliveryAttempts: 3,
      }),
    );
    expect(recorder).toHaveBeenCalledWith({
      jobId: 'job-1',
      installationId: 'installation-1',
      eventId: 'event-1',
      messageId: 'message-3',
      deliveryAttempt: 3,
      terminal: true,
      code: 'QUEUE_PROCESSOR_ERROR',
    });
    expect(recorder.mock.invocationCallOrder[0]).toBeLessThan(
      item.retry.mock.invocationCallOrder[0]!,
    );
    expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
  });

  test('recorder failure is safely logged and still retried', async () => {
    const item = message(body);
    const log = logger();
    await consumeConnectorQueue(
      { messages: [item] },
      consumerDependencies(
        vi.fn(async () => Promise.reject(new Error('raw'))),
        {
          logger: log,
          recordFailure: vi.fn(async () => Promise.reject(new Error('secret'))),
        },
      ),
    );
    expect(item.retry).toHaveBeenCalledOnce();
    expect(item.ack).not.toHaveBeenCalled();
    expect(
      JSON.stringify(Object.values(log).flatMap((fn) => fn.mock.calls)),
    ).not.toMatch(/raw|secret/iu);
  });
});

describe('queue failure recorder', () => {
  test('creates deterministic idempotent safe activity without unfenced job mutation', async () => {
    const activities = new Map<string, unknown>();
    const append = vi.fn(async (activity: { activityId: string }) => {
      activities.set(activity.activityId, activity);
    });
    const record = createActivityStoreQueueFailureRecorder({
      activities: { append, list: vi.fn(async () => []) },
      clock: { now: () => new Date('2026-07-19T02:00:00.000Z') },
    });
    const failure = {
      jobId: 'job-1',
      installationId: 'installation-1',
      eventId: 'event-1',
      messageId: 'message-3',
      deliveryAttempt: 3,
      terminal: true,
      code: 'QUEUE_PROCESSOR_ERROR' as const,
    };
    await record(failure);
    await record(failure);
    expect(activities).toHaveLength(1);
    expect([...activities.values()][0]).toMatchObject({
      result: 'terminal_failure',
      attempt: 3,
      code: 'QUEUE_DELIVERY_EXHAUSTED',
    });
  });
});

function logger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function consumerDependencies(
  processConnectorEvent: (...args: never[]) => Promise<unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    processConnectorEvent,
    logger: logger(),
    recordFailure: vi.fn(async () => undefined),
    maxDeliveryAttempts: 5,
    ...overrides,
  } as never;
}

function serializedBytes(value: ConnectorJob): number {
  return new TextEncoder().encode(
    JSON.stringify({ version: CONNECTOR_QUEUE_PAYLOAD_VERSION, job: value }),
  ).byteLength;
}

function jobWithSerializedBytes(bytes: number): ConnectorJob {
  const empty = {
    ...job,
    event: { ...job.event, data: { value: '' } },
  };
  const paddingBytes = bytes - serializedBytes(empty);
  if (paddingBytes < 0) throw new Error('requested payload is too small');
  return {
    ...empty,
    event: { ...empty.event, data: { value: 'x'.repeat(paddingBytes) } },
  };
}
