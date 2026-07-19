import { z } from 'zod';

const installationFields = {
  installationId: z.string().min(1),
  workspaceId: z.string().min(1),
  applicationId: z.string().min(1),
  environmentId: z.string().min(1),
  environmentKind: z.enum(['production', 'non_production']),
  extensionVersion: z.string().min(1),
  providerAccountReference: z.string().min(1).optional(),
  lastSuccessfulSyncCursor: z.string().min(1).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
} as const;

export const installationSchema = z.discriminatedUnion('status', [
  z
    .object({
      ...installationFields,
      status: z.enum(['pending', 'active', 'disconnected']),
      uninstalledAt: z.never().optional(),
    })
    .strict(),
  z
    .object({
      ...installationFields,
      status: z.literal('uninstalled'),
      uninstalledAt: z.iso.datetime(),
    })
    .strict(),
]);

export type Installation = z.infer<typeof installationSchema>;

export const webhookVerificationCandidateSchema = z
  .object({ installationId: z.string().min(1) })
  .strict();
export type WebhookVerificationCandidate = z.infer<
  typeof webhookVerificationCandidateSchema
>;

export const MAX_WEBHOOK_VERIFICATION_CANDIDATES = 100;
