import { describe, expect, test, vi } from 'vitest';
import type { ConnectorJob } from '@starter/contracts';
import {
  CONNECTOR_QUEUE_PAYLOAD_VERSION,
  MAX_QUEUE_PAYLOAD_BYTES,
  consumeConnectorQueue,
  createCloudflareQueueProducer,
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
    expect(queue.send).toHaveBeenCalledWith({
      version: CONNECTOR_QUEUE_PAYLOAD_VERSION,
      job,
    });
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

  test('rejects oversized payloads before send', async () => {
    const queue = { send: vi.fn(async () => undefined) };
    const oversized = {
      ...job,
      event: {
        ...job.event,
        data: { value: 'x'.repeat(MAX_QUEUE_PAYLOAD_BYTES) },
      },
    };
    await expect(
      createCloudflareQueueProducer(queue).enqueue(oversized),
    ).rejects.toThrow(/payload.*large/iu);
    expect(queue.send).not.toHaveBeenCalled();
  });

  test('rejects malformed and non-cloneable inputs before send', async () => {
    const queue = { send: vi.fn(async () => undefined) };
    for (const invalid of [
      { ...job, event: { ...job.event, data: { value: () => undefined } } },
      { ...job, createdAt: 'yesterday' },
    ])
      await expect(
        createCloudflareQueueProducer(queue).enqueue(invalid),
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
      { processConnectorEvent: vi.fn(async () => result), logger: logger() },
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
        },
      );
      expect(item.retry).toHaveBeenCalledOnce();
      expect(item.retry).toHaveBeenCalledWith({ delaySeconds });
      expect(item.ack).not.toHaveBeenCalled();
    },
  );

  test('acks malformed messages without calling or logging their raw body', async () => {
    const item = message({ accessToken: 'raw-secret' });
    const log = logger();
    const process = vi.fn();
    await consumeConnectorQueue(
      { messages: [item] },
      { processConnectorEvent: process, logger: log },
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
      { processConnectorEvent: process, logger: log },
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
        },
      ),
    ).rejects.toThrow('ack transport failed');
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
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
