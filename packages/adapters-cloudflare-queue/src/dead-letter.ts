import type { ActivityStore, Clock, Logger } from '@starter/core';
import type { CloudflareQueueMessageBatch } from './consumer.js';
import { connectorQueuePayloadSchema } from './producer.js';

/** A job Cloudflare gave up redelivering to the main consumer. */
export interface DeadLetteredJob {
  jobId: string;
  installationId: string;
  eventId: string;
  messageId: string;
}

export interface DeadLetterConsumerDependencies {
  recordDeadLetter(job: DeadLetteredJob): Promise<void>;
  logger: Logger;
}

/**
 * Drains the dead-letter queue for the sole purpose of leaving a trace.
 *
 * A job that exhausts its delivery attempts lands in the dead-letter queue,
 * and Cloudflare expires those messages on its own retention clock. Without a
 * consumer the only evidence that work was abandoned disappears on a timer —
 * no activity row, no log line. This writes that evidence into the activity
 * feed you already read, then acknowledges unconditionally: a dead-letter
 * queue is the end of the line, so retrying here only replays the message
 * until it expires unread anyway.
 *
 * It deliberately does not re-drive the job. Queue consumers hold no execution
 * lease, and re-running an arbitrary connector job from here would bypass the
 * fencing that keeps at-most-once provider side effects safe. Re-driving
 * abandoned work is a policy decision for a separately fenced reconciliation
 * path, not for this recorder.
 */
export async function consumeDeadLetterQueue(
  batch: CloudflareQueueMessageBatch,
  dependencies: DeadLetterConsumerDependencies,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      const parsed = connectorQueuePayloadSchema.safeParse(message.body);
      if (!parsed.success) {
        // Unattributable to any installation, so no activity row is possible.
        dependencies.logger.warn('Discarded unreadable dead-letter message', {
          messageId: message.id,
          code: 'DEAD_LETTER_UNREADABLE',
        });
        message.ack();
        return;
      }
      const { job } = parsed.data;
      try {
        await dependencies.recordDeadLetter({
          jobId: job.jobId,
          installationId: job.installationId,
          eventId: job.event.id,
          messageId: message.id,
        });
      } catch {
        dependencies.logger.error('Dead-letter recording failed', {
          jobId: job.jobId,
          installationId: job.installationId,
          eventId: job.event.id,
          code: 'DEAD_LETTER_RECORDING_FAILED',
        });
      }
      message.ack();
    }),
  );
}

/**
 * Persists an idempotent terminal activity for an abandoned job. Like the
 * retry-path failure recorder it never touches the job row: queue consumers
 * hold no execution lease, and an unfenced write is exactly the corruption the
 * lease exists to prevent.
 */
export function createActivityStoreDeadLetterRecorder(dependencies: {
  activities: ActivityStore;
  clock: Clock;
}): (job: DeadLetteredJob) => Promise<void> {
  return async (job) => {
    await dependencies.activities.append({
      activityId: JSON.stringify(['dead_letter', job.jobId, job.messageId]),
      installationId: job.installationId,
      eventId: job.eventId,
      jobId: job.jobId,
      type: 'connector_sync',
      status: 'completed',
      result: 'terminal_failure',
      attempt: 0,
      code: 'QUEUE_DEAD_LETTERED',
      createdAt: dependencies.clock.now().toISOString(),
    });
  };
}

/**
 * One Worker has a single `queue()` handler for every queue bound to it, so
 * the batch's own queue name is what separates ordinary work from work
 * Cloudflare has given up on.
 *
 * Anything not positively identified as the dead-letter queue routes to the
 * connector. Guessing wrong in that direction costs a redelivery; guessing
 * wrong in the other would file a live job as abandoned and drop it.
 */
export function createQueueRouter(dependencies: {
  deadLetterQueue?: string;
  connector(batch: CloudflareQueueMessageBatch): Promise<void>;
  deadLetter(batch: CloudflareQueueMessageBatch): Promise<void>;
}): (batch: CloudflareQueueMessageBatch) => Promise<void> {
  return async (batch) => {
    const isDeadLetter =
      dependencies.deadLetterQueue !== undefined &&
      batch.queue === dependencies.deadLetterQueue;
    await (isDeadLetter
      ? dependencies.deadLetter(batch)
      : dependencies.connector(batch));
  };
}
