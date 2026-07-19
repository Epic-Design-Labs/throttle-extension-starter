export const MAX_WEBHOOK_VERIFICATION_CANDIDATES = 100;
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
export const MAX_WEBHOOK_JSON_DEPTH = 10;

export interface UntrustedWebhookRoutingHint {
  readonly trusted: false;
  readonly workspaceId: string;
  readonly environmentId: string;
}

const hasSafeDepth = (root: unknown): boolean => {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_WEBHOOK_JSON_DEPTH) return false;
    if (typeof current.value === 'object' && current.value !== null) {
      for (const value of Object.values(current.value))
        pending.push({ value, depth: current.depth + 1 });
    }
  }
  return true;
};

export interface BoundedWebhookJson {
  readonly value: unknown;
}

/** @internal Shared bounded JSON gate used before any webhook trust decision. */
export function parseBoundedWebhookJson(
  rawBody: unknown,
): BoundedWebhookJson | null {
  if (
    typeof rawBody !== 'string' ||
    rawBody.length === 0 ||
    new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES
  )
    return null;
  try {
    const value: unknown = JSON.parse(rawBody);
    return hasSafeDepth(value) ? { value } : null;
  } catch {
    return null;
  }
}

/** This parse is only a bounded lookup hint. Its values are attacker-controlled. */
export function parseWebhookRoutingHint(
  rawBody: unknown,
): UntrustedWebhookRoutingHint | null {
  const bounded = parseBoundedWebhookJson(rawBody);
  if (bounded === null) return null;
  try {
    const parsed = bounded.value;
    if (
      !hasSafeDepth(parsed) ||
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    )
      return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.workspaceId !== 'string' ||
      value.workspaceId.length === 0 ||
      typeof value.environmentId !== 'string' ||
      value.environmentId.length === 0
    )
      return null;
    return {
      trusted: false,
      workspaceId: value.workspaceId,
      environmentId: value.environmentId,
    };
  } catch {
    return null;
  }
}
