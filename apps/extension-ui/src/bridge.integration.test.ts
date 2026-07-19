import type { BridgeSessionContext } from '@usethrottle/extension-bridge';
import {
  BRIDGE_SOURCE_HOST,
  BRIDGE_SOURCE_IFRAME,
} from '@usethrottle/extension-bridge/protocol';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createBackendClient } from './api.js';
import { createExtensionBridge } from './bridge.js';

const dashboardOrigin = 'https://dashboard.usethrottle.dev';
const context: BridgeSessionContext = {
  user: { id: 'user-1', email: 'dev@example.test' },
  workspace: { id: 'workspace-1', slug: 'workspace' },
  application: { id: 'application-1', slug: 'application' },
  environment: {
    environmentId: 'environment-1',
    environmentSlug: 'test',
    environmentKind: 'non_production',
    providerEnvironment: 'sandbox',
  },
  installationId: 'installation-1',
  extensionId: 'extension-1',
  version: '1.0.0',
  role: 'admin',
  scopes: ['connector:read'],
};

const originalParent = window.parent;
afterEach(() => {
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: originalParent,
  });
  vi.restoreAllMocks();
});

function sessionMessage(
  parent: WindowProxy,
  token: string,
  origin = dashboardOrigin,
) {
  window.dispatchEvent(
    new MessageEvent('message', {
      source: parent,
      origin,
      data: {
        source: BRIDGE_SOURCE_HOST,
        type: 'session',
        token,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        context,
        apiBaseUrl: 'https://api.usethrottle.dev',
      },
    }),
  );
}

function fakeHost(
  onPost?: (message: unknown, parent: WindowProxy) => void,
): WindowProxy {
  const parent = {
    postMessage: vi.fn((message: unknown) => onPost?.(message, parent)),
  } as unknown as WindowProxy;
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: parent,
  });
  return parent;
}

describe('real Throttle bridge refresh flow', () => {
  test('requests a host refresh after 401 and retries with the received token', async () => {
    const parent = fakeHost((message, source) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { source?: unknown }).source === BRIDGE_SOURCE_IFRAME &&
        (message as { type?: unknown }).type === 'refresh'
      )
        queueMicrotask(() => sessionMessage(source, 'fresh-token'));
    });
    const bridge = createExtensionBridge({
      dashboardOrigin,
      useMockBridge: false,
      production: true,
      refreshTimeoutMs: 100,
    });
    sessionMessage(parent, 'expired-token');
    await bridge.ready;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: 'AUTHENTICATION_FAILED' } },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ status: 'active' }));
    const client = createBackendClient({
      baseUrl: 'https://connector.example',
      mode: 'throttle',
      getToken: () => bridge.getToken(),
      refreshToken: () => bridge.refreshToken(),
      fetcher,
    });

    await expect(client.getInstallation()).resolves.toEqual({
      status: 'active',
    });
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization'),
    ).toBe('Bearer expired-token');
    expect(
      new Headers(fetcher.mock.calls[1]![1]?.headers).get('authorization'),
    ).toBe('Bearer fresh-token');
    expect(parent.postMessage).toHaveBeenCalledWith(
      { source: BRIDGE_SOURCE_IFRAME, type: 'refresh' },
      dashboardOrigin,
    );
    bridge.destroy();
  });

  test('deduplicates refreshes and times out untrusted host messages with cleanup', async () => {
    const parent = fakeHost();
    const remove = vi.spyOn(window, 'removeEventListener');
    const bridge = createExtensionBridge({
      dashboardOrigin,
      useMockBridge: false,
      production: true,
      refreshTimeoutMs: 20,
    });
    sessionMessage(parent, 'expired-token');
    await bridge.ready;

    const first = bridge.refreshToken();
    const second = bridge.refreshToken();
    expect(first).toBe(second);
    sessionMessage({} as WindowProxy, 'attacker-token');
    sessionMessage(parent, 'wrong-origin-token', 'https://evil.example');
    await expect(first).rejects.toMatchObject({
      code: 'BRIDGE_REFRESH_TIMEOUT',
    });
    expect(
      vi
        .mocked(parent.postMessage)
        .mock.calls.filter(
          ([message]) => (message as { type?: unknown }).type === 'refresh',
        ),
    ).toHaveLength(1);
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function));
    bridge.destroy();
  });

  test('rejects and cleans an in-flight refresh when destroyed', async () => {
    const parent = fakeHost();
    const remove = vi.spyOn(window, 'removeEventListener');
    const bridge = createExtensionBridge({
      dashboardOrigin,
      useMockBridge: false,
      production: true,
      refreshTimeoutMs: 100,
    });
    sessionMessage(parent, 'token');
    await bridge.ready;
    const pending = bridge.refreshToken();
    bridge.destroy();

    await expect(pending).rejects.toMatchObject({
      code: 'BRIDGE_DESTROYED',
    });
    expect(remove).toHaveBeenCalledWith('message', expect.any(Function));
  });
});
