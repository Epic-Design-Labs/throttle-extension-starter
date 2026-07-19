import { z } from 'zod';

export const activitySchema = z
  .object({
    activityId: z.string().min(1),
    installationId: z.string().min(1),
    eventId: z.string().min(1).optional(),
    jobId: z.string().min(1).optional(),
    type: z.enum(['event_received', 'connector_sync']),
    status: z.enum(['pending', 'processing', 'completed']),
    result: z.enum([
      'success',
      'retryable_failure',
      'terminal_failure',
      'skipped',
    ]),
    attempt: z.number().int().nonnegative(),
    message: z.string().min(1).max(500).optional(),
    code: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .max(100)
      .optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();

export type Activity = z.infer<typeof activitySchema>;
