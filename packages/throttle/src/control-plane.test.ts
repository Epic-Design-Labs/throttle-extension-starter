import { describe, expect, test, vi } from 'vitest';
import { createThrottleControlPlane } from './control-plane.js';

const key = new TextEncoder().encode('sk_live_abc');

describe('createThrottleControlPlane.fetchWebhookSigningSecret', () => {
  test('reads the secret with the installation API key and returns the bytes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ data: { signingSecret: 'whsec_new' } }), {
          status: 200,
        }),
    );
    const cp = createThrottleControlPlane({
      apiOrigin: 'https://api.usethrottle.dev/.well-known/x',
      fetch,
    });
    const out = await cp.fetchWebhookSigningSecret({
      installationId: 'inst-1',
      apiKey: key,
    });
    expect(new TextDecoder().decode(out!)).toBe('whsec_new');
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe(
      'https://api.usethrottle.dev/api/v1/installations/inst-1/webhook-secret',
    );
    expect(call?.[1]?.headers).toMatchObject({ 'x-api-key': 'sk_live_abc' });
  });

  test('404 and 409 mean "nothing to read"; other failures throw so the job retries', async () => {
    for (const status of [404, 409]) {
      const cp = createThrottleControlPlane({
        apiOrigin: 'https://api.usethrottle.dev',
        fetch: async () => new Response('', { status }),
      });
      expect(
        await cp.fetchWebhookSigningSecret({
          installationId: 'i',
          apiKey: key,
        }),
      ).toBeUndefined();
    }
    const cp = createThrottleControlPlane({
      apiOrigin: 'https://api.usethrottle.dev',
      fetch: async () => new Response('', { status: 503 }),
    });
    await expect(
      cp.fetchWebhookSigningSecret({ installationId: 'i', apiKey: key }),
    ).rejects.toThrow('HTTP 503');
    const bad = createThrottleControlPlane({
      apiOrigin: 'https://api.usethrottle.dev',
      fetch: async () => new Response('{"data":{}}', { status: 200 }),
    });
    await expect(
      bad.fetchWebhookSigningSecret({ installationId: 'i', apiKey: key }),
    ).rejects.toThrow('no signingSecret');
  });
});
