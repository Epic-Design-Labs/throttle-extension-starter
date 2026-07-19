import {
  createBridge,
  type BridgeSessionContext,
} from '@usethrottle/extension-bridge';

export type BridgeMode = 'throttle' | 'local-mock';
export interface ExtensionBridge {
  ready: Promise<BridgeSessionContext>;
  mode: BridgeMode;
  getToken(): string | null;
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

export type BridgeOptions = {
  dashboardOrigin?: string;
  useMockBridge: boolean;
  production: boolean;
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
  validateDashboardOrigin(options.dashboardOrigin);
  const bridge = createBridge({ targetOrigin: options.dashboardOrigin });
  return {
    mode: 'throttle',
    ready: bridge.ready,
    getToken: () => bridge.getToken(),
    resize: (height) => bridge.resize(height),
    toast: (message, level) => bridge.toast(message, level),
    destroy: () => bridge.destroy(),
  };
}
