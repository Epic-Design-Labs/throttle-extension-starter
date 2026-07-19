import type { Installation } from '@starter/contracts';
import type { VerifiedExtensionIdentity } from '@starter/throttle';
import { describe, expect, test, vi } from 'vitest';
import { createApp, type AppDependencies } from './app.js';

const now = new Date('2026-01-02T03:04:05.000Z');
const identity: VerifiedExtensionIdentity = {
  installationId: 'install-1',
  extensionId: 'extension-1',
  version: '1.2.3',
  workspaceId: 'workspace-1',
  applicationId: 'application-1',
  environmentId: 'environment-1',
  environmentKind: 'non_production',
  providerEnvironment: 'sandbox',
  role: 'admin',
  scopes: ['connector:read', 'connector:write'],
  userId: 'user-1',
  userEmail: 'dev@example.test',
};
const installation: Installation = {
  installationId: identity.installationId,
  workspaceId: identity.workspaceId,
  applicationId: identity.applicationId,
  environmentId: identity.environmentId,
  environmentKind: identity.environmentKind,
  extensionVersion: identity.version,
  status: 'active',
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

function fixture(overrides: Partial<AppDependencies> = {}) {
  const log = vi.fn();
  const deps: AppDependencies = {
    dashboardOrigin: 'https://dashboard.usethrottle.dev',
    authorizationScopes: {
      read: 'connector:read',
      mutation: 'connector:write',
    },
    clock: { now: () => now },
    createRequestId: () => 'request-safe-1',
    identityVerifier: { verify: vi.fn(async () => identity) },
    readiness: vi.fn(async () => true),
    installations: {
      get: vi.fn(async () => installation),
      findWebhookVerificationCandidates: vi.fn(async () => []),
    },
    credentials: { get: vi.fn(async () => undefined) },
    bootstrap: vi.fn(async () => installation),
    acceptJob: vi.fn(async () => ({ accepted: true })),
    queue: { enqueue: vi.fn(async () => undefined) },
    connect: vi.fn(async () => installation),
    activities: { list: vi.fn(async () => []) },
    configurations: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    },
    uninstall: vi.fn(async () => undefined),
    logger: { debug: log, info: log, warn: log, error: log },
    ...overrides,
  };
  return { app: createApp(deps), deps, log };
}

const auth = { Authorization: 'Bearer one-token' };

describe('worker HTTP application', () => {
  test('liveness has no dependency and ignores an inbound request id', async () => {
    const { app, deps } = fixture();
    const response = await app.request('/health/live', {
      headers: { 'x-request-id': 'attacker-secret' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(deps.readiness).not.toHaveBeenCalled();
    expect(response.headers.get('x-request-id')).toBe('request-safe-1');
  });

  test('readiness fails closed without leaking details', async () => {
    const { app } = fixture({ readiness: vi.fn(async () => false) });
    const response = await app.request('/health/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready' });
  });

  test('requires exactly one Bearer token on API routes', async () => {
    const { app, deps } = fixture();
    for (const authorization of [
      undefined,
      'Basic abc',
      'Bearer',
      'Bearer one two',
      'Bearer one, Bearer two',
    ]) {
      const response = await app.request('/api/installation', {
        headers: authorization ? { Authorization: authorization } : {},
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: {
          code: 'AUTHENTICATION_FAILED',
          message: 'Authentication failed.',
          requestId: 'request-safe-1',
        },
      });
    }
    expect(deps.identityVerifier.verify).not.toHaveBeenCalled();
  });

  test('allows viewer reads but denies setup mutations', async () => {
    const viewer = { ...identity, role: 'viewer' as const };
    const { app, deps } = fixture({
      identityVerifier: { verify: vi.fn(async () => viewer) },
    });
    expect(
      (await app.request('/api/installation', { headers: auth })).status,
    ).toBe(200);
    const response = await app.request('/api/connector/config', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(deps.configurations.set).not.toHaveBeenCalled();
  });

  test('denies valid tokens missing the route permission scope', async () => {
    const { app } = fixture({
      identityVerifier: {
        verify: vi.fn(async () => ({
          ...identity,
          scopes: ['connector:read'],
        })),
      },
    });
    const response = await app.request('/api/connector/config', {
      method: 'PUT',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(403);
  });

  test('rejects a verified identity that does not match stored tenant scope', async () => {
    const { app } = fixture({
      installations: {
        get: vi.fn(async () => undefined),
        findWebhookVerificationCandidates: vi.fn(async () => []),
      },
    });
    expect(
      (await app.request('/api/connector', { headers: auth })).status,
    ).toBe(403);
  });

  test('bootstraps transient secrets without returning or logging them', async () => {
    const { app, deps, log } = fixture();
    const response = await app.request(
      'https://worker.example/api/installation/secrets',
      {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          throttleApiKey: 'api-super-secret',
          webhookSigningSecret: 'hook-super-secret',
          replace: false,
        }),
      },
    );
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain('super-secret');
    expect(deps.bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ identity, replace: false }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('super-secret');
  });

  test('refuses secret bootstrap over plaintext HTTP', async () => {
    const { app, deps } = fixture();
    const response = await app.request(
      'http://worker.example/api/installation/secrets',
      {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          throttleApiKey: 'api-super-secret',
          webhookSigningSecret: 'hook-super-secret',
          replace: false,
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(deps.bootstrap).not.toHaveBeenCalled();
  });

  test('locks CORS to the configured HTTPS dashboard origin', async () => {
    const { app } = fixture();
    const denied = await app.request('/api/installation', {
      headers: { ...auth, Origin: 'https://evil.example' },
    });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    const allowed = await app.request('/api/installation', {
      headers: { ...auth, Origin: 'https://dashboard.usethrottle.dev' },
    });
    expect(allowed.headers.get('access-control-allow-origin')).toBe(
      'https://dashboard.usethrottle.dev',
    );
  });

  test('rejects JSON-like but non-JSON media types', async () => {
    const { app, deps } = fixture();
    const response = await app.request(
      'https://worker.example/api/installation/secrets',
      {
        method: 'PUT',
        headers: { ...auth, 'content-type': 'application/jsonp' },
        body: JSON.stringify({
          throttleApiKey: 'api-secret',
          webhookSigningSecret: 'hook-secret',
          replace: false,
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(deps.bootstrap).not.toHaveBeenCalled();
  });
});

async function signedWebhook(secret: string, event: object) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(now.valueOf() / 1000);
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
  const digest = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return { body, signature: `t=${timestamp},v1=${digest}` };
}

describe('Throttle webhook ingress', () => {
  const event = {
    id: 'event-1',
    type: 'order.created',
    workspaceId: 'workspace-1',
    environmentId: 'environment-1',
    createdAt: now.toISOString(),
    data: { orderId: 'order-1' },
  };

  test('persists and enqueues one deterministic job for accepted and duplicate delivery', async () => {
    const secret = 'webhook-secret';
    const signed = await signedWebhook(secret, event);
    const { app, deps } = fixture({
      clock: {
        now: vi
          .fn()
          .mockReturnValueOnce(now)
          .mockReturnValueOnce(now)
          .mockReturnValueOnce(new Date(now.valueOf() + 1000))
          .mockReturnValueOnce(new Date(now.valueOf() + 2000)),
      },
      installations: {
        get: vi.fn(async () => installation),
        findWebhookVerificationCandidates: vi.fn(async () => [
          { installationId: 'install-1' },
        ]),
      },
      credentials: {
        get: vi.fn(async () => new TextEncoder().encode(secret)),
      },
      acceptJob: vi
        .fn()
        .mockResolvedValueOnce({ accepted: true })
        .mockResolvedValueOnce({ accepted: false }),
    });
    for (let index = 0; index < 2; index++) {
      const response = await app.request('/webhooks/throttle', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-throttle-signature': signed.signature,
          'x-throttle-event-id': event.id,
          'x-throttle-event-type': event.type,
        },
        body: signed.body,
      });
      expect(response.status).toBe(202);
    }
    const firstJob = vi.mocked(deps.queue.enqueue).mock.calls[0]![0];
    const secondJob = vi.mocked(deps.queue.enqueue).mock.calls[1]![0];
    expect(firstJob).toEqual(secondJob);
    expect(firstJob.jobId).toBe(JSON.stringify(['install-1', 'event-1']));
    expect(deps.queue.enqueue).toHaveBeenCalledTimes(2);
  });

  test('returns retryable 5xx when queue send fails and re-enqueues same job on retry', async () => {
    const secret = 'webhook-secret';
    const signed = await signedWebhook(secret, event);
    const enqueue = vi
      .fn()
      .mockRejectedValueOnce(new Error('queue secret detail'))
      .mockResolvedValueOnce(undefined);
    const { app, deps, log } = fixture({
      installations: {
        get: vi.fn(async () => installation),
        findWebhookVerificationCandidates: vi.fn(async () => [
          { installationId: 'install-1' },
        ]),
      },
      credentials: {
        get: vi.fn(async () => new TextEncoder().encode(secret)),
      },
      acceptJob: vi.fn(async () => ({ accepted: false })),
      queue: { enqueue },
    });
    const request = () =>
      app.request('/webhooks/throttle', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-throttle-signature': signed.signature,
          'x-throttle-event-id': event.id,
          'x-throttle-event-type': event.type,
        },
        body: signed.body,
      });
    expect((await request()).status).toBe(503);
    expect((await request()).status).toBe(202);
    expect(enqueue.mock.calls[0]![0]).toEqual(enqueue.mock.calls[1]![0]);
    expect(JSON.stringify(log.mock.calls)).not.toContain('queue secret detail');
    expect(deps.acceptJob).toHaveBeenCalledTimes(2);
  });

  test('fails closed on an invalid signature and wipes candidate secret buffers', async () => {
    const candidateSecret = new TextEncoder().encode('webhook-secret');
    const { app, deps } = fixture({
      installations: {
        get: vi.fn(async () => installation),
        findWebhookVerificationCandidates: vi.fn(async () => [
          { installationId: 'install-1' },
        ]),
      },
      credentials: { get: vi.fn(async () => candidateSecret) },
    });
    const response = await app.request('/webhooks/throttle', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-throttle-signature': `t=${Math.floor(now.valueOf() / 1000)},v1=${'0'.repeat(64)}`,
        'x-throttle-event-id': event.id,
        'x-throttle-event-type': event.type,
      },
      body: JSON.stringify(event),
    });
    expect(response.status).toBe(401);
    expect([...candidateSecret]).toEqual(
      new Array(candidateSecret.length).fill(0),
    );
    expect(deps.acceptJob).not.toHaveBeenCalled();
  });

  test('requires the JSON media type', async () => {
    const { app } = fixture();
    const response = await app.request('/webhooks/throttle', {
      method: 'POST',
      headers: { 'content-type': 'application/jsonp' },
      body: JSON.stringify(event),
    });
    expect(response.status).toBe(415);
  });

  test('rejects a declared oversized body before candidate lookup', async () => {
    const { app, deps } = fixture();
    const response = await app.request('/webhooks/throttle', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(64 * 1024 + 1),
      },
      body: JSON.stringify(event),
    });
    expect(response.status).toBe(413);
    expect(
      deps.installations.findWebhookVerificationCandidates,
    ).not.toHaveBeenCalled();
  });

  test('hard-caps an oversized chunked body without Content-Length', async () => {
    const { app, deps } = fixture();
    const response = await app.request('/webhooks/throttle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(64 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(
      deps.installations.findWebhookVerificationCandidates,
    ).not.toHaveBeenCalled();
  });
});
