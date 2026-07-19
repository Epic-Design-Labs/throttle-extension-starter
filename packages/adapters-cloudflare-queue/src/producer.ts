import { connectorJobSchema, type ConnectorJob } from '@starter/contracts';
import type { JobQueue } from '@starter/core';
import { z } from 'zod';

export const CONNECTOR_QUEUE_PAYLOAD_VERSION = 1 as const;
/** Cloudflare Queues' documented per-message limit is 128 KiB. */
export const MAX_QUEUE_PAYLOAD_BYTES = 128 * 1024;

export const connectorQueuePayloadSchema = z
  .object({
    version: z.literal(CONNECTOR_QUEUE_PAYLOAD_VERSION),
    job: connectorJobSchema,
  })
  .strict();
export type ConnectorQueuePayload = z.infer<typeof connectorQueuePayloadSchema>;

export interface CloudflareQueue {
  send(body: ConnectorQueuePayload): Promise<void>;
}

export function createCloudflareQueueProducer(
  queue: CloudflareQueue,
): JobQueue {
  return {
    async enqueue(input: ConnectorJob): Promise<void> {
      const job = connectorJobSchema.parse(input);
      const payload = connectorQueuePayloadSchema.parse({
        version: CONNECTOR_QUEUE_PAYLOAD_VERSION,
        job,
      });
      // Schema validation already restricts values to JSON. Keep this explicit
      // so future contract changes cannot pass non-cloneable values to Queue.
      structuredClone(payload);
      const bytes = new TextEncoder().encode(
        JSON.stringify(payload),
      ).byteLength;
      if (bytes > MAX_QUEUE_PAYLOAD_BYTES)
        throw new Error('Queue payload is too large');
      await queue.send(payload);
    },
  };
}
