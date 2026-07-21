import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  MAX_WEBHOOK_SIGNATURE_HEADER_BYTES,
  MAX_WEBHOOK_V1_SIGNATURES,
  verifyThrottleWebhook,
  verifyWebhookSignature,
} from './webhooks.js';
import { MAX_WEBHOOK_BODY_BYTES, MAX_WEBHOOK_JSON_DEPTH } from './events.js';

const rawBody =
  '{"id":"evt_1","type":"deployment.created","version":"1","workspaceId":"ws_1","environmentId":"env_1","createdAt":"2026-01-01T00:00:00.000Z","data":{}}';
const secret = 'whsec_test';
const timestamp = 1_767_225_600;
const digest =
  'eaa3ce9a2d307ce160d9963b08859f64c4c392b4f3b8f602ab0b517b39a6c057';
const signature = `t=${timestamp},v1=${digest}`;
const secretBytes = (value = secret) => new TextEncoder().encode(value);
const signBody = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    ),
  );
  return `t=${timestamp},v1=${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

describe('verifyWebhookSignature', () => {
  it('accepts byte secrets without mutating the caller-owned buffer', async () => {
    const key = secretBytes();
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature,
        signingSecret: key,
        now: timestamp,
      }),
    ).resolves.toBe(true);
    expect(key).toEqual(secretBytes());
  });
  it('accepts the exact signed raw body at the tolerance boundary', async () => {
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature,
        signingSecret: secretBytes(),
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
        signingSecret: secretBytes(key),
        now: timestamp,
      }),
    ).resolves.toBe(false);
  });
  it('rejects stale and future timestamps outside tolerance', async () => {
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature,
        signingSecret: secretBytes(),
        now: timestamp + 301,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature,
        signingSecret: secretBytes(),
        now: timestamp - 301,
      }),
    ).resolves.toBe(false);
  });
  it('accepts any matching v1 signature for key rotation', async () => {
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature: `t=${timestamp},v1=${'0'.repeat(64)},v1=${digest}`,
        signingSecret: secretBytes(),
        now: timestamp,
      }),
    ).resolves.toBe(true);
  });
  it('accepts the maximum v1 count and rejects any excess or oversized header', async () => {
    const maximum = [
      `t=${timestamp}`,
      ...Array.from(
        { length: MAX_WEBHOOK_V1_SIGNATURES - 1 },
        () => `v1=${'0'.repeat(64)}`,
      ),
      `v1=${digest}`,
    ].join(',');
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature: maximum,
        signingSecret: secretBytes(),
        now: timestamp,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature: `${maximum},v1=${digest}`,
        signingSecret: secretBytes(),
        now: timestamp,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyWebhookSignature({
        rawBody,
        signature: signature.padEnd(
          MAX_WEBHOOK_SIGNATURE_HEADER_BYTES + 1,
          '0',
        ),
        signingSecret: secretBytes(),
        now: timestamp,
      }),
    ).resolves.toBe(false);
  });
  it('fails closed for invalid runtime input', async () => {
    for (const value of ['', null, 1])
      await expect(
        verifyWebhookSignature({
          rawBody: value as string,
          signature,
          signingSecret: secretBytes(),
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

it('rejects malformed, excessive, and ambiguous candidates', async () => {
  const base = {
    rawBody,
    signature,
    eventId: 'evt_1',
    eventType: 'deployment.created',
    now: timestamp,
  };
  await expect(
    verifyThrottleWebhook({
      ...base,
      candidates: [
        { installationId: 'inst_1', signingSecret: secretBytes() },
        { installationId: '', signingSecret: secretBytes('bad') },
      ],
    }),
  ).resolves.toBeNull();
  await expect(
    verifyThrottleWebhook({
      ...base,
      candidates: [
        { installationId: 'inst_1', signingSecret: secretBytes() },
        { installationId: 'inst_2', signingSecret: secretBytes() },
      ],
    }),
  ).resolves.toBeNull();
  await expect(
    verifyThrottleWebhook({
      ...base,
      candidates: [
        { installationId: 'inst_1', signingSecret: secretBytes() },
        { installationId: 'inst_1', signingSecret: secretBytes() },
      ],
    }),
  ).resolves.toMatchObject({ installationId: 'inst_1' });
});

it('processes 100 candidates and can match the final candidate', async () => {
  const candidates = Array.from({ length: 100 }, (_, index) => ({
    installationId: `inst_${index}`,
    signingSecret: secretBytes(index === 99 ? secret : `wrong_${index}`),
  }));
  await expect(
    verifyThrottleWebhook({
      rawBody,
      signature,
      eventId: 'evt_1',
      eventType: 'deployment.created',
      candidates,
      now: timestamp,
    }),
  ).resolves.toMatchObject({ installationId: 'inst_99' });
});

it('returns a trusted event and matched installation only after header checks', async () => {
  await expect(
    verifyThrottleWebhook({
      rawBody,
      signature,
      eventId: 'evt_1',
      eventType: 'deployment.created',
      candidates: [{ installationId: 'inst_1', signingSecret: secretBytes() }],
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
      candidates: [{ installationId: 'inst_1', signingSecret: secretBytes() }],
      now: timestamp,
    }),
  ).resolves.toBeNull();
});

it('rejects an oversized body even when its signature and schema are valid', async () => {
  const body = JSON.stringify({
    id: 'evt_big',
    type: 'big',
    workspaceId: 'ws_1',
    environmentId: 'env_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    data: { padding: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES) },
  });
  await expect(
    verifyThrottleWebhook({
      rawBody: body,
      signature: await signBody(body),
      eventId: 'evt_big',
      eventType: 'big',
      candidates: [{ installationId: 'inst_1', signingSecret: secretBytes() }],
      now: timestamp,
    }),
  ).resolves.toBeNull();
});

it('rejects excessive JSON nesting even when its signature and schema are valid', async () => {
  let nested: unknown = 'leaf';
  for (let depth = 0; depth <= MAX_WEBHOOK_JSON_DEPTH; depth += 1)
    nested = { nested };
  const body = JSON.stringify({
    id: 'evt_deep',
    type: 'deep',
    workspaceId: 'ws_1',
    environmentId: 'env_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    data: { nested },
  });
  await expect(
    verifyThrottleWebhook({
      rawBody: body,
      signature: await signBody(body),
      eventId: 'evt_deep',
      eventType: 'deep',
      candidates: [{ installationId: 'inst_1', signingSecret: secretBytes() }],
      now: timestamp,
    }),
  ).resolves.toBeNull();
});
