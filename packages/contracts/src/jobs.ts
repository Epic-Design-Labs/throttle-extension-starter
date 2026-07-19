import { z } from 'zod';

import { throttleEventSchema } from './events.js';

export const connectorJobSchema = z
  .object({
    jobId: z.string().min(1),
    installationId: z.string().min(1),
    event: throttleEventSchema,
    createdAt: z.iso.datetime(),
  })
  .strict();

export type ConnectorJob = z.infer<typeof connectorJobSchema>;
