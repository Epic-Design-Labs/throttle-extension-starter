import type { ThrottleControlPlane } from '@starter/core';

/** Largest secret-read response we will parse; a real one is well under 1 KiB. */
const MAX_SECRET_RESPONSE_BYTES = 16 * 1024;

export interface ThrottleControlPlaneOptions {
  /** `https://api.usethrottle.dev` — derive it from THROTTLE_JWKS_URL's origin. */
  apiOrigin: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * HTTP implementation of the control-plane port: reads the installation's
 * current webhook signing secret with the installation's own API key. The
 * key bytes are decoded only for the header and the decoded string is not
 * retained.
 */
export function createThrottleControlPlane(
  options: ThrottleControlPlaneOptions,
): ThrottleControlPlane {
  const origin = new URL(options.apiOrigin).origin;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    async fetchWebhookSigningSecret({ installationId, apiKey }) {
      const url = `${origin}/api/v1/installations/${encodeURIComponent(installationId)}/webhook-secret`;
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-api-key': new TextDecoder().decode(apiKey),
        },
      });
      if (response.status === 404 || response.status === 409) return undefined;
      if (!response.ok)
        throw new Error(
          `Throttle webhook-secret read failed: HTTP ${response.status}`,
        );
      const text = await response.text();
      if (text.length > MAX_SECRET_RESPONSE_BYTES)
        throw new Error('Throttle webhook-secret response too large');
      let secret: unknown;
      try {
        secret = (JSON.parse(text) as { data?: { signingSecret?: unknown } })
          .data?.signingSecret;
      } catch {
        throw new Error('Throttle webhook-secret response was not JSON');
      }
      if (typeof secret !== 'string' || secret.length === 0)
        throw new Error(
          'Throttle webhook-secret response had no signingSecret',
        );
      return new TextEncoder().encode(secret);
    },
  };
}
