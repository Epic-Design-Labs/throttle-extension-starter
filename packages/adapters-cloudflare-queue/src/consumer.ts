import type { ConnectorJob } from '@starter/contracts';
import type { Logger, ProcessConnectorEventResult } from '@starter/core';
import { connectorQueuePayloadSchema } from './producer.js';

const UNEXPECTED_RETRY_DELAY_SECONDS = 5;
const MAX_CLOUDFLARE_DELAY_SECONDS = 43_200;

export interface CloudflareQueueMessage {
  body: unknown;
  attempts?: number;
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
}

function retryDelay(value: number): number {
  return Number.isInteger(value) &&
    value >= 0 &&
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
