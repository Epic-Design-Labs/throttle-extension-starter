import { z } from 'zod';

export const installationSchema = z
  .object({
    installationId: z.string().min(1),
    workspaceId: z.string().min(1),
    applicationId: z.string().min(1),
    environmentId: z.string().min(1),
    environmentKind: z.enum(['production', 'non_production']),
    extensionVersion: z.string().min(1),
    providerAccountReference: z.string().min(1).optional(),
    status: z.enum(['pending', 'active', 'disconnected', 'uninstalled']),
    lastSuccessfulSyncCursor: z.string().min(1).optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    uninstalledAt: z.iso.datetime().optional(),
  })
  .strict();

export type Installation = z.infer<typeof installationSchema>;

export const webhookVerificationCandidateSchema = z
  .object({ installationId: z.string().min(1) })
  .strict();
export type WebhookVerificationCandidate = z.infer<
  typeof webhookVerificationCandidateSchema
>;

export const MAX_WEBHOOK_VERIFICATION_CANDIDATES = 100;
