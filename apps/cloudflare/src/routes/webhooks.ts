import type { ConnectorJob } from '@starter/contracts';
import {
  MAX_WEBHOOK_VERIFICATION_CANDIDATES,
  MAX_WEBHOOK_BODY_BYTES,
  parseWebhookRoutingHint,
  verifyThrottleWebhook,
} from '@starter/throttle';
import type { Hono } from 'hono';
import type { AppBindings, AppDependencies } from '../app.js';
import { readBoundedUtf8Body } from '../middleware/body.js';
import { isJsonContentType } from '../middleware/content-type.js';
import { HttpError, invalidRequest } from '../middleware/errors.js';

export function registerWebhookRoutes(
  app: Hono<AppBindings>,
  dependencies: AppDependencies,
) {
  app.post('/webhooks/throttle', async (c) => {
    if (!isJsonContentType(c.req.header('content-type')))
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON is required.');
    const rawBody = await readBoundedUtf8Body({
      request: c.req.raw,
      maxBytes: MAX_WEBHOOK_BODY_BYTES,
      tooLargeCode: 'WEBHOOK_BODY_TOO_LARGE',
    });
    const hint = parseWebhookRoutingHint(rawBody);
    if (hint === null) throw invalidRequest();
    let candidates;
    try {
      candidates =
        await dependencies.installations.findWebhookVerificationCandidates({
          workspaceId: hint.workspaceId,
          environmentId: hint.environmentId,
        });
    } catch {
      throw new HttpError(
        503,
        'WEBHOOK_UNAVAILABLE',
        'Webhook processing is temporarily unavailable.',
      );
    }
    if (candidates.status === 'overflow')
      throw new HttpError(
        401,
        'WEBHOOK_VERIFICATION_FAILED',
        'Webhook verification failed.',
      );
    if (
      candidates.candidates.length === 0 ||
      candidates.candidates.length > MAX_WEBHOOK_VERIFICATION_CANDIDATES
    )
      throw new HttpError(
        401,
        'WEBHOOK_VERIFICATION_FAILED',
        'Webhook verification failed.',
      );
    const buffers: Uint8Array[] = [];
    try {
      const verificationCandidates: Array<{
        installationId: string;
        signingSecret: Uint8Array;
      }> = [];
      for (const candidate of candidates.candidates) {
        const secret = await dependencies.credentials.get(
          candidate.installationId,
          'webhookSigningSecret',
        );
        if (!secret) continue;
        buffers.push(secret);
        verificationCandidates.push({
          installationId: candidate.installationId,
          signingSecret: secret,
        });
      }
      const verified = await verifyThrottleWebhook({
        rawBody,
        signature: c.req.header('x-throttle-signature'),
        eventId: c.req.header('x-throttle-event-id'),
        eventType: c.req.header('x-throttle-event-type'),
        candidates: verificationCandidates,
        now: Math.floor(dependencies.clock.now().valueOf() / 1000),
      });
      if (verified === null)
        throw new HttpError(
          401,
          'WEBHOOK_VERIFICATION_FAILED',
          'Webhook verification failed.',
        );
      const job: ConnectorJob = {
        jobId: JSON.stringify([verified.installationId, verified.event.id]),
        installationId: verified.installationId,
        event: verified.event,
        createdAt: verified.event.createdAt,
      };
      try {
        await dependencies.acceptJob(job);
        // Deliberately send for both newly accepted and duplicate deliveries.
        // A prior database commit may have survived a failed Queue send.
        await dependencies.queue.enqueue(job);
      } catch {
        throw new HttpError(
          503,
          'WEBHOOK_UNAVAILABLE',
          'Webhook processing is temporarily unavailable.',
        );
      }
      return c.json({ status: 'accepted' as const }, 202);
    } finally {
      for (const buffer of buffers) buffer.fill(0);
    }
  });
}
