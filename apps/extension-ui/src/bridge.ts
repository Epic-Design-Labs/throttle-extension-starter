import {
  createBridge,
  type BridgeSessionContext,
} from '@usethrottle/extension-bridge';
import {
  BRIDGE_SOURCE_HOST,
  BRIDGE_SOURCE_IFRAME,
} from '@usethrottle/extension-bridge/protocol';

export type BridgeMode = 'throttle' | 'local-mock';
export interface ExtensionBridge {
  ready: Promise<BridgeSessionContext>;
  mode: BridgeMode;
  getToken(): string | null;
  refreshToken(): Promise<string>;
  resize(heightPx: number): void;
  toast(
    message: string,
    level?: 'info' | 'success' | 'warning' | 'error',
  ): void;
  destroy(): void;
}

export class InvalidBridgeConfigurationError extends Error {
  constructor() {
    super('The extension bridge configuration is invalid.');
    this.name = 'InvalidBridgeConfigurationError';
  }
}

export class BridgeRefreshError extends Error {
  readonly code: 'BRIDGE_REFRESH_TIMEOUT' | 'BRIDGE_DESTROYED';

  constructor(code: BridgeRefreshError['code']) {
    super(
      code === 'BRIDGE_REFRESH_TIMEOUT'
        ? 'The Throttle session refresh timed out.'
        : 'The Throttle bridge was destroyed.',
    );
    this.name = 'BridgeRefreshError';
    this.code = code;
  }
}

export type BridgeOptions = {
  dashboardOrigin?: string;
  useMockBridge: boolean;
  production: boolean;
  refreshTimeoutMs?: number;
};

function validateDashboardOrigin(
  value: string | undefined,
): asserts value is string {
  try {
    if (value === undefined) throw new InvalidBridgeConfigurationError();
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.origin !== value)
      throw new InvalidBridgeConfigurationError();
  } catch (error) {
    if (error instanceof InvalidBridgeConfigurationError) throw error;
    throw new InvalidBridgeConfigurationError();
  }
}

function localBridge(): ExtensionBridge {
  const context: BridgeSessionContext = {
    user: { id: 'local-user', email: 'developer@example.test' },
    workspace: { id: 'local-workspace', slug: 'local-workspace' },
    application: { id: 'local-application', slug: 'local-application' },
    environment: {
      environmentId: 'local-environment',
      environmentSlug: 'test',
      environmentKind: 'non_production',
      providerEnvironment: 'sandbox',
    },
    installationId: 'local-installation',
    extensionId: 'local-extension',
    version: '0.0.0-local',
    role: 'admin',
    scopes: ['connector:read', 'connector:write'],
  };
  return {
    mode: 'local-mock',
    ready: Promise.resolve(context),
    getToken: () => 'local-development-token',
    refreshToken: async () => 'local-development-token',
    resize: () => undefined,
    toast: () => undefined,
    destroy: () => undefined,
  };
}

export function createExtensionBridge(
  options: BridgeOptions = {
    dashboardOrigin: import.meta.env.VITE_THROTTLE_DASHBOARD_ORIGIN,
    useMockBridge: import.meta.env.VITE_USE_MOCK_BRIDGE === 'true',
    production: import.meta.env.PROD,
  },
): ExtensionBridge {
  if (options.useMockBridge) {
    if (options.production) throw new InvalidBridgeConfigurationError();
    return localBridge();
  }
  const dashboardOrigin = options.dashboardOrigin;
  validateDashboardOrigin(dashboardOrigin);
  const refreshTimeoutMs = options.refreshTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(refreshTimeoutMs) ||
    refreshTimeoutMs < 1 ||
    refreshTimeoutMs > 30_000
  )
    throw new InvalidBridgeConfigurationError();
  const bridge = createBridge({ targetOrigin: dashboardOrigin });
  let destroyed = false;
  let refreshPromise: Promise<string> | undefined;
  let cancelRefresh: ((error: BridgeRefreshError) => void) | undefined;

  const refreshToken = (): Promise<string> => {
    if (destroyed)
      return Promise.reject(new BridgeRefreshError('BRIDGE_DESTROYED'));
    if (refreshPromise) return refreshPromise;
    let resolveRefresh!: (token: string) => void;
    let rejectRefresh!: (error: BridgeRefreshError) => void;
    const pending = new Promise<string>((resolve, reject) => {
      resolveRefresh = resolve;
      rejectRefresh = reject;
    });
    refreshPromise = pending;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      window.removeEventListener('message', onSession);
      clearTimeout(timer);
      refreshPromise = undefined;
      cancelRefresh = undefined;
    };
    const fail = (error: BridgeRefreshError) => {
      cleanup();
      rejectRefresh(error);
    };
    const onSession = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        event.origin !== dashboardOrigin
      )
        return;
      const data = event.data as Record<string, unknown> | null;
      if (
        !data ||
        data.source !== BRIDGE_SOURCE_HOST ||
        data.type !== 'session' ||
        typeof data.token !== 'string' ||
        data.token.length === 0 ||
        typeof data.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(data.expiresAt))
      )
        return;
      cleanup();
      const token = bridge.getToken();
      if (!token) {
        rejectRefresh(new BridgeRefreshError('BRIDGE_REFRESH_TIMEOUT'));
        return;
      }
      resolveRefresh(token);
    };
    window.addEventListener('message', onSession);
    cancelRefresh = fail;
    timer = setTimeout(
      () => fail(new BridgeRefreshError('BRIDGE_REFRESH_TIMEOUT')),
      refreshTimeoutMs,
    );
    window.parent.postMessage(
      { source: BRIDGE_SOURCE_IFRAME, type: 'refresh' },
      dashboardOrigin,
    );
    return pending;
  };
  return {
    mode: 'throttle',
    ready: bridge.ready,
    getToken: () => bridge.getToken(),
    refreshToken,
    resize: (height) => bridge.resize(height),
    toast: (message, level) => bridge.toast(message, level),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      cancelRefresh?.(new BridgeRefreshError('BRIDGE_DESTROYED'));
      bridge.destroy();
    },
  };
}
