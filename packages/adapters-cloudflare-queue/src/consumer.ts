import type { ConnectorJob } from '@starter/contracts';
import type { Logger, ProcessConnectorEventResult } from '@starter/core';
import { connectorQueuePayloadSchema } from './producer.js';

const UNEXPECTED_RETRY_DELAY_SECONDS = 5;
const MAX_CLOUDFLARE_DELAY_SECONDS = 43_200;

export interface CloudflareQueueMessage {
  id: string;
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options: { delaySeconds: number }): void;
}

export interface CloudflareQueueMessageBatch {
  messages: readonly CloudflareQueueMessage[];
}

export interface ConnectorQueueConsumerDependencies {
  processConnectorEvent(
    job: ConnectorJob,
  ): Promise<ProcessConnectorEventResult>;
  logger: Logger;
  recordFailure(failure: QueueFailureRecord): Promise<void>;
  maxDeliveryAttempts: number;
}

export interface QueueFailureRecord {
  jobId: string;
  installationId: string;
  eventId: string;
  messageId: string;
  deliveryAttempt: number;
  terminal: boolean;
  code: 'QUEUE_PROCESSOR_ERROR';
}

function unsupportedVersion(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return false;
  const envelope = body as Record<string, unknown>;
  if (
    !Number.isInteger(envelope.version) ||
    (envelope.version as number) < 1 ||
    envelope.version === 1 ||
    typeof envelope.job !== 'object' ||
    envelope.job === null ||
    Array.isArray(envelope.job)
  )
    return false;
  const job = envelope.job as Record<string, unknown>;
  const event = job.event as Record<string, unknown> | undefined;
  return (
    typeof job.jobId === 'string' &&
    job.jobId.length > 0 &&
    typeof job.installationId === 'string' &&
    job.installationId.length > 0 &&
    typeof event?.id === 'string' &&
    event.id.length > 0
  );
}

function retryDelay(value: number): number {
  return Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_CLOUDFLARE_DELAY_SECONDS
    ? value
    : UNEXPECTED_RETRY_DELAY_SECONDS;
}

async function consumeMessage(
  message: CloudflareQueueMessage,
  dependencies: ConnectorQueueConsumerDependencies,
): Promise<void> {
  const parsed = connectorQueuePayloadSchema.safeParse(message.body);
  if (!parsed.success) {
    if (unsupportedVersion(message.body)) {
      dependencies.logger.warn('Unsupported connector queue version', {
        code: 'UNSUPPORTED_QUEUE_VERSION',
      });
      message.retry({ delaySeconds: UNEXPECTED_RETRY_DELAY_SECONDS });
      return;
    }
    dependencies.logger.warn('Invalid connector queue message', {
      code: 'INVALID_QUEUE_PAYLOAD',
    });
    message.ack();
    return;
  }
  const { job } = parsed.data;
  let result: ProcessConnectorEventResult;
  try {
    result = await dependencies.processConnectorEvent(job);
  } catch {
    dependencies.logger.error('Connector queue processor failed', {
      jobId: job.jobId,
      installationId: job.installationId,
      eventId: job.event.id,
      code: 'QUEUE_PROCESSOR_ERROR',
    });
    const deliveryAttempt =
      Number.isInteger(message.attempts) && message.attempts > 0
        ? message.attempts
        : 1;
    const maxDeliveryAttempts =
      Number.isInteger(dependencies.maxDeliveryAttempts) &&
      dependencies.maxDeliveryAttempts > 0
        ? dependencies.maxDeliveryAttempts
        : 1;
    try {
      await dependencies.recordFailure({
        jobId: job.jobId,
        installationId: job.installationId,
        eventId: job.event.id,
        messageId: message.id,
        deliveryAttempt,
        terminal: deliveryAttempt >= maxDeliveryAttempts,
        code: 'QUEUE_PROCESSOR_ERROR',
      });
    } catch {
      dependencies.logger.error('Connector queue failure recording failed', {
        jobId: job.jobId,
        installationId: job.installationId,
        eventId: job.event.id,
        code: 'QUEUE_FAILURE_RECORDING_FAILED',
      });
    }
    message.retry({ delaySeconds: UNEXPECTED_RETRY_DELAY_SECONDS });
    return;
  }
  if (result.status === 'retry') {
    message.retry({ delaySeconds: retryDelay(result.delaySeconds) });
    return;
  }
  message.ack();
}

/**
 * Processes each Queue message independently. Configure a Cloudflare Queue
 * max_retries and dead-letter queue; durable business attempts are enforced by
 * the injected processor and deliberately ignore Cloudflare delivery attempts.
 */
export async function consumeConnectorQueue(
  batch: CloudflareQueueMessageBatch,
  dependencies: ConnectorQueueConsumerDependencies,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) =>
      consumeMessage(message, dependencies),
    ),
  );
}
