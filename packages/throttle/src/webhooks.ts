import { throttleEventSchema, type ThrottleEvent } from '@starter/contracts';
import { MAX_WEBHOOK_VERIFICATION_CANDIDATES } from './events.js';

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/u;
const DEFAULT_TOLERANCE_SECONDS = 300;

export interface WebhookCandidate {
  installationId: string;
  signingSecret: string;
}
export interface VerifiedThrottleWebhook {
  installationId: string;
  event: ThrottleEvent;
}

const decodeHex = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );

/** XOR/OR accumulation examines max(left.length, right.length) bytes. */
export function constantTimeEqual(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

export async function verifyWebhookSignature(input: {
  rawBody: unknown;
  signature: unknown;
  signingSecret: unknown;
  now?: number | undefined;
  toleranceSeconds?: number | undefined;
}): Promise<boolean> {
  try {
    const { rawBody, signature, signingSecret } = input;
    if (
      typeof rawBody !== 'string' ||
      rawBody.length === 0 ||
      typeof signature !== 'string' ||
      signature.length === 0 ||
      typeof signingSecret !== 'string' ||
      signingSecret.length === 0
    )
      return false;
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(tolerance) ||
      tolerance < 0
    )
      return false;
    const parts = signature.split(',').map((part) => part.split('='));
    if (parts.some((part) => part.length !== 2)) return false;
    const timestamps = parts
      .filter(([key]) => key === 't')
      .map(([, value]) => value!);
    const signatures = parts
      .filter(([key]) => key === 'v1')
      .map(([, value]) => value!);
    if (
      parts.some(([key]) => key !== 't' && key !== 'v1') ||
      timestamps.length !== 1 ||
      signatures.length === 0 ||
      signatures.some((value) => !HEX_SHA256.test(value))
    )
      return false;
    const timestampText = timestamps[0]!;
    if (!/^(?:0|[1-9][0-9]*)$/u.test(timestampText)) return false;
    const timestamp = Number(timestampText);
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp < 0 ||
      Math.abs(now - timestamp) > tolerance
    )
      return false;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(signingSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const expected = new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${timestampText}.${rawBody}`),
      ),
    );
    let matched = false;
    for (const candidate of signatures)
      matched = constantTimeEqual(expected, decodeHex(candidate)) || matched;
    return matched;
  } catch {
    return false;
  }
}

export async function verifyThrottleWebhook(input: {
  rawBody: unknown;
  signature: unknown;
  eventId: unknown;
  eventType: unknown;
  candidates: readonly WebhookCandidate[];
  now?: number;
  toleranceSeconds?: number;
}): Promise<VerifiedThrottleWebhook | null> {
  if (
    !Array.isArray(input.candidates) ||
    input.candidates.length === 0 ||
    input.candidates.length > MAX_WEBHOOK_VERIFICATION_CANDIDATES ||
    typeof input.rawBody !== 'string' ||
    typeof input.eventId !== 'string' ||
    input.eventId.length === 0 ||
    typeof input.eventType !== 'string' ||
    input.eventType.length === 0
  )
    return null;
  let installationId: string | null = null;
  for (const candidate of input.candidates) {
    if (
      typeof candidate?.installationId !== 'string' ||
      candidate.installationId.length === 0 ||
      typeof candidate.signingSecret !== 'string' ||
      candidate.signingSecret.length === 0
    )
      return null;
    if (
      await verifyWebhookSignature({
        rawBody: input.rawBody,
        signature: input.signature,
        signingSecret: candidate.signingSecret,
        now: input.now,
        toleranceSeconds: input.toleranceSeconds,
      })
    )
      installationId ??= candidate.installationId;
  }
  if (installationId === null) return null;
  try {
    const event = throttleEventSchema.parse(JSON.parse(input.rawBody));
    return event.id === input.eventId && event.type === input.eventType
      ? { installationId, event }
      : null;
  } catch {
    return null;
  }
}
