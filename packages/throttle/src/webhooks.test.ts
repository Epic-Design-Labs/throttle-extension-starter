import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  verifyThrottleWebhook,
  verifyWebhookSignature,
} from './webhooks.js';

const rawBody =
  '{"id":"evt_1","type":"deployment.created","workspaceId":"ws_1","environmentId":"env_1","createdAt":"2026-01-01T00:00:00.000Z","data":{}}';
const secret = 'whsec_test';
const timestamp = 1_767_225_600;
const digest =
  'ccfa0262d8bd7bba53bf18ed39e92d97e61898341d4bf387e79ff2470c2c9368';
const signature = `t=${timestamp},v1=${digest}`;

describe('verifyWebhookSignature', () => {
  it('accepts the exact signed raw body at the tolerance boundary', async () => {
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature,
        signingSecret: secret,
        now: timestamp + 300,
      }),
    ).resolves.toBe(true);
  });
  it.each([
    ['altered whitespace', rawBody + ' ', signature, secret],
    ['wrong secret', rawBody, signature, 'wrong'],
    ['missing timestamp', rawBody, `v1=${digest}`, secret],
    ['duplicate timestamp', rawBody, `${signature},t=${timestamp}`, secret],
    ['missing v1', rawBody, `t=${timestamp}`, secret],
    ['malformed digest', rawBody, `t=${timestamp},v1=xyz`, secret],
    ['short digest', rawBody, `t=${timestamp},v1=00`, secret],
    ['fractional timestamp', rawBody, `t=1.5,v1=${digest}`, secret],
    ['negative timestamp', rawBody, `t=-1,v1=${digest}`, secret],
  ])('rejects %s', async (_name, body, header, key) => {
    await expect(
      verifyWebhookSignature({
        rawBody: body,
        signature: header,
        signingSecret: key,
        now: timestamp,
      }),
    ).resolves.toBe(false);
  });
  it('rejects stale and future timestamps outside tolerance', async () => {
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature,
        signingSecret: secret,
        now: timestamp + 301,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature,
        signingSecret: secret,
        now: timestamp - 301,
      }),
    ).resolves.toBe(false);
  });
  it('accepts any matching v1 signature for key rotation', async () => {
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature: `t=${timestamp},v1=${'0'.repeat(64)},v1=${digest}`,
        signingSecret: secret,
        now: timestamp,
      }),
    ).resolves.toBe(true);
  });
  it('fails closed for invalid runtime input', async () => {
    for (const value of ['', null, 1])
      await expect(
        verifyWebhookSignature({
          rawBody: value as string,
          signature,
          signingSecret: secret,
          now: timestamp,
        }),
      ).resolves.toBe(false);
  });
  it('compares every byte without an early return', () => {
    expect(
      constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([9, 2, 3])),
    ).toBe(false);
    expect(constantTimeEqual(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(
      false,
    );
  });
});

it('returns a trusted event and matched installation only after header checks', async () => {
  await expect(
    verifyThrottleWebhook({
      rawBody,
      signature,
      eventId: 'evt_1',
      eventType: 'deployment.created',
      candidates: [{ installationId: 'inst_1', signingSecret: secret }],
      now: timestamp,
    }),
  ).resolves.toMatchObject({
    installationId: 'inst_1',
    event: { id: 'evt_1' },
  });
  await expect(
    verifyThrottleWebhook({
      rawBody,
      signature,
      eventId: 'wrong',
      eventType: 'deployment.created',
      candidates: [{ installationId: 'inst_1', signingSecret: secret }],
      now: timestamp,
    }),
  ).resolves.toBeNull();
});
