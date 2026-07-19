import type { ConnectorJob } from '@starter/contracts';
import {
  MAX_WEBHOOK_VERIFICATION_CANDIDATES,
  MAX_WEBHOOK_BODY_BYTES,
  parseWebhookRoutingHint,
  verifyThrottleWebhook,
} from '@starter/throttle';
import type { Hono } from 'hono';
import type { AppBindings, AppDependencies } from '../app.js';
import { isJsonContentType } from '../middleware/content-type.js';
import { HttpError, invalidRequest } from '../middleware/errors.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

async function readBoundedRawBody(request: Request): Promise<string> {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^[0-9]+$/u.test(contentLength) ||
      Number(contentLength) > MAX_WEBHOOK_BODY_BYTES)
  )
    throw new HttpError(
      413,
      'WEBHOOK_BODY_TOO_LARGE',
      'The request is too large.',
    );
  if (request.body === null) throw invalidRequest();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_WEBHOOK_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(
        413,
        'WEBHOOK_BODY_TOO_LARGE',
        'The request is too large.',
      );
    }
    chunks.push(value);
  }
  const rawBytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    rawBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return decoder.decode(rawBytes);
  } catch {
    throw invalidRequest();
  } finally {
    rawBytes.fill(0);
  }
}

export function registerWebhookRoutes(
  app: Hono<AppBindings>,
  dependencies: AppDependencies,
) {
  app.post('/webhooks/throttle', async (c) => {
    if (!isJsonContentType(c.req.header('content-type')))
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON is required.');
    const rawBody = await readBoundedRawBody(c.req.raw);
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
    if (
      candidates.length === 0 ||
      candidates.length > MAX_WEBHOOK_VERIFICATION_CANDIDATES
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
        signingSecret: string;
      }> = [];
      for (const candidate of candidates) {
        const secret = await dependencies.credentials.get(
          candidate.installationId,
          'webhookSigningSecret',
        );
        if (!secret) continue;
        buffers.push(secret);
        try {
          verificationCandidates.push({
            installationId: candidate.installationId,
            signingSecret: decoder.decode(secret),
          });
        } catch {
          // Corrupt credentials never become verification candidates.
        }
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
