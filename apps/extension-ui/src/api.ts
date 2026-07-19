import type { Activity, ConfigurationValue } from '@starter/contracts';

export interface ApiErrorInput {
  status: number;
  code: string;
  message: string;
  requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(input: ApiErrorInput) {
    super(input.message);
    this.name = 'ApiError';
    this.status = input.status;
    this.code = input.code;
    this.requestId = input.requestId;
  }

  get retryable() {
    return this.status >= 500;
  }
}

export type InstallationResponse = {
  status:
    'not_configured' | 'pending' | 'active' | 'disconnected' | 'uninstalled';
};
export type ConnectorResponse = { status: 'connected' | 'not_connected' };
export type ConfigurationResponse = {
  configuration: ConfigurationValue | null;
};
export type ActivityResponse = { activities: Activity[] };

export interface BackendClient {
  getInstallation(): Promise<InstallationResponse>;
  bootstrapSecrets(input: {
    throttleApiKey: string;
    webhookSigningSecret: string;
    replace: boolean;
  }): Promise<{ status: string }>;
  getConnector(): Promise<ConnectorResponse>;
  connectProvider(credentials: string): Promise<{ status: string }>;
  getConfiguration(): Promise<ConfigurationResponse>;
  saveConfiguration(
    configuration: ConfigurationValue,
  ): Promise<{ status: string }>;
  getActivity(): Promise<ActivityResponse>;
}

type ClientOptions = {
  baseUrl: string;
  getToken(): string | null;
  fetcher?: typeof fetch;
};

type ErrorBody = {
  error?: { code?: unknown; message?: unknown; requestId?: unknown };
};

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol))
    throw new Error('Backend URL must use HTTP or HTTPS');
  return url.href.replace(/\/$/u, '');
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // A stable fallback is safer than surfacing an upstream response body.
  }
  return new ApiError({
    status: response.status,
    code:
      typeof body.error?.code === 'string' ? body.error.code : 'REQUEST_FAILED',
    message:
      typeof body.error?.message === 'string'
        ? body.error.message
        : 'The connector request could not be completed.',
    ...(typeof body.error?.requestId === 'string'
      ? { requestId: body.error.requestId }
      : {}),
  });
}

export function createBackendClient(options: ClientOptions): BackendClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetcher = options.fetcher ?? fetch;

  async function request<T>(
    path: string,
    init: Omit<RequestInit, 'headers'> = {},
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = options.getToken();
      if (!token)
        throw new ApiError({
          status: 401,
          code: 'BRIDGE_SESSION_UNAVAILABLE',
          message: 'The Throttle session is unavailable.',
        });
      const headers = new Headers({ Authorization: `Bearer ${token}` });
      if (init.body !== undefined)
        headers.set('content-type', 'application/json');
      const response = await fetcher(`${baseUrl}${path}`, {
        ...init,
        headers,
      });
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw await errorFromResponse(response);
      return (await response.json()) as T;
    }
    throw new Error('Unreachable authentication retry state');
  }

  return {
    getInstallation: () => request('/api/installation'),
    bootstrapSecrets: (input) =>
      request('/api/installation/secrets', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    getConnector: () => request('/api/connector'),
    connectProvider: (credentials) =>
      request('/api/connector/credentials', {
        method: 'PUT',
        body: JSON.stringify({ credentials }),
      }),
    getConfiguration: () => request('/api/connector/config'),
    saveConfiguration: (configuration) =>
      request('/api/connector/config', {
        method: 'PUT',
        body: JSON.stringify(configuration),
      }),
    getActivity: () => request('/api/activity'),
  };
}
