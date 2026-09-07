import type { ConnectorJob } from '@starter/contracts';
import { describe, expect, test, vi } from 'vitest';
import {
  CONNECTOR_QUEUE_PAYLOAD_VERSION,
  consumeDeadLetterQueue,
  createActivityStoreDeadLetterRecorder,
  createQueueRouter,
} from './index.js';

const job: ConnectorJob = {
  jobId: 'job-1',
  installationId: 'installation-1',
  createdAt: '2026-09-07T00:00:00.000Z',
  event: {
    id: 'event-1',
    type: 'order.updated',
    version: '1',
    workspaceId: 'workspace-1',
    environmentId: 'environment-1',
    createdAt: '2026-09-07T00:00:00.000Z',
    data: { order: { id: 'order-1' } },
  },
};

function message(body: unknown) {
  return { id: 'message-1', body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
}

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const payload = { version: CONNECTOR_QUEUE_PAYLOAD_VERSION, job };

describe('dead-letter consumer', () => {
  test('records the job that exhausted delivery and acknowledges it', async () => {
    const recordDeadLetter = vi.fn(async () => undefined);
    const dlq = message(payload);

    await consumeDeadLetterQueue(
      { messages: [dlq] },
      { recordDeadLetter, logger: logger() },
    );

    expect(recordDeadLetter).toHaveBeenCalledWith({
      jobId: 'job-1',
      installationId: 'installation-1',
      eventId: 'event-1',
      messageId: 'message-1',
    });
    expect(dlq.ack).toHaveBeenCalled();
  });

  // A dead-letter queue is the end of the line: there is nowhere left to
  // retry to, so retrying only replays the message until it expires unread —
  // exactly the silence this consumer exists to remove.
  test('never retries, even when recording fails', async () => {
    const dlq = message(payload);
    const log = logger();

    await consumeDeadLetterQueue(
      { messages: [dlq] },
      {
        recordDeadLetter: vi.fn(async () => {
          throw new Error('D1 unavailable');
        }),
        logger: log,
      },
    );

    expect(dlq.retry).not.toHaveBeenCalled();
    expect(dlq.ack).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  // Nothing can be attributed to an installation, so there is no activity row
  // to write — but the operator still needs to know a message was discarded.
  test('logs and acknowledges a message it cannot parse', async () => {
    const recordDeadLetter = vi.fn(async () => undefined);
    const dlq = message({ nonsense: true });
    const log = logger();

    await consumeDeadLetterQueue(
      { messages: [dlq] },
      { recordDeadLetter, logger: log },
    );

    expect(recordDeadLetter).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    expect(dlq.ack).toHaveBeenCalled();
  });

  test('one unrecordable message does not strand the rest of the batch', async () => {
    const first = message({ nonsense: true });
    const second = message(payload);
    const recordDeadLetter = vi.fn(async () => undefined);

    await consumeDeadLetterQueue(
      { messages: [first, second] },
      { recordDeadLetter, logger: logger() },
    );

    expect(recordDeadLetter).toHaveBeenCalledTimes(1);
    expect(first.ack).toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalled();
  });
});

describe('dead-letter activity recorder', () => {
  test('writes one idempotent terminal activity naming the queue as the cause', async () => {
    const appended = new Map<string, unknown>();
    const record = createActivityStoreDeadLetterRecorder({
      activities: {
        append: vi.fn(async (activity: { activityId: string }) => {
          appended.set(activity.activityId, activity);
        }),
        list: vi.fn(async () => []),
      },
      clock: { now: () => new Date('2026-09-07T02:00:00.000Z') },
    });
    const dead = {
      jobId: 'job-1',
      installationId: 'installation-1',
      eventId: 'event-1',
      messageId: 'message-1',
    };

    await record(dead);
    await record(dead);

    // Same activityId both times: the store dedupes, so a redelivered
    // dead-letter message records exactly one row.
    expect(appended.size).toBe(1);
    expect([...appended.values()][0]).toMatchObject({
      installationId: 'installation-1',
      eventId: 'event-1',
      jobId: 'job-1',
      type: 'connector_sync',
      status: 'completed',
      result: 'terminal_failure',
      attempt: 0,
      code: 'QUEUE_DEAD_LETTERED',
      createdAt: '2026-09-07T02:00:00.000Z',
    });
  });
});

describe('queue routing', () => {
  const routed = async (
    queue: string | undefined,
    deadLetterQueue?: string,
  ) => {
    const connector = vi.fn(async () => undefined);
    const deadLetter = vi.fn(async () => undefined);
    const route = createQueueRouter({
      ...(deadLetterQueue === undefined ? {} : { deadLetterQueue }),
      connector,
      deadLetter,
    });
    const batch = {
      messages: [message(payload)],
      ...(queue === undefined ? {} : { queue }),
    };
    await route(batch);
    return { connector, deadLetter };
  };

  test('sends the dead-letter queue to the dead-letter consumer', async () => {
    const { connector, deadLetter } = await routed('dlq', 'dlq');
    expect(deadLetter).toHaveBeenCalled();
    expect(connector).not.toHaveBeenCalled();
  });

  test('sends the main queue to the connector consumer', async () => {
    const { connector, deadLetter } = await routed('main', 'dlq');
    expect(connector).toHaveBeenCalled();
    expect(deadLetter).not.toHaveBeenCalled();
  });

  // Both fallbacks route to the connector rather than the dead-letter path.
  // Recording a live job as abandoned is the more damaging mistake: it would
  // drop the work and log it as already handled.
  test.each([
    ['no dead-letter queue is configured', 'dlq', undefined],
    ['the batch names no queue', undefined, 'dlq'],
  ] as const)(
    'falls back to the connector when %s',
    async (_label, queue, dlq) => {
      const { connector, deadLetter } = await routed(queue, dlq);
      expect(connector).toHaveBeenCalled();
      expect(deadLetter).not.toHaveBeenCalled();
    },
  );
});
