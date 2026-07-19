import { createBridge } from '@usethrottle/extension-bridge';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  InvalidBridgeConfigurationError,
  createExtensionBridge,
} from './bridge.js';

vi.mock('@usethrottle/extension-bridge', () => ({
  createBridge: vi.fn(() => ({
    ready: Promise.resolve({}),
    getToken: vi.fn(() => 'token'),
    refreshToken: vi.fn(async () => 'token'),
    resize: vi.fn(),
    toast: vi.fn(),
    destroy: vi.fn(),
  })),
}));

describe('extension bridge composition', () => {
  beforeEach(() => vi.clearAllMocks());

  test('pins the production bridge to the configured exact HTTPS origin', () => {
    createExtensionBridge({
      dashboardOrigin: 'https://dashboard.usethrottle.dev',
      useMockBridge: false,
      production: true,
    });

    expect(createBridge).toHaveBeenCalledOnce();
    expect(createBridge).toHaveBeenCalledWith({
      targetOrigin: 'https://dashboard.usethrottle.dev',
    });
  });

  test.each([
    '',
    'http://dashboard.usethrottle.dev',
    'https://dashboard.usethrottle.dev/path',
    'https://dashboard.usethrottle.dev/',
  ])('rejects unsafe dashboard origin %j', (dashboardOrigin) => {
    expect(() =>
      createExtensionBridge({
        dashboardOrigin,
        useMockBridge: false,
        production: true,
      }),
    ).toThrow(InvalidBridgeConfigurationError);
    expect(createBridge).not.toHaveBeenCalled();
  });

  test.each([undefined, 'not-a-dashboard-origin'])(
    'uses a visibly local non-production mock without validating dashboard origin %j',
    async (dashboardOrigin) => {
      const bridge = createExtensionBridge({
        ...(dashboardOrigin === undefined ? {} : { dashboardOrigin }),
        useMockBridge: true,
        production: false,
      });

      await expect(bridge.ready).resolves.toMatchObject({
        workspace: { slug: 'local-workspace' },
        environment: {
          environmentKind: 'non_production',
          providerEnvironment: 'sandbox',
        },
      });
      expect(bridge.mode).toBe('local-mock');
      expect(createBridge).not.toHaveBeenCalled();
    },
  );

  test('refuses to enable the mock bridge in a production build', () => {
    expect(() =>
      createExtensionBridge({
        useMockBridge: true,
        production: true,
      }),
    ).toThrow(InvalidBridgeConfigurationError);
  });
});
