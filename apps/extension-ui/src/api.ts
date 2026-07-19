import {
  activitySchema,
  validateConfigurationValue,
  type Activity,
  type ConfigurationValue,
} from '@starter/contracts';

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
export type RequestOptions = { signal?: AbortSignal };

export interface BackendClient {
  getInstallation(options?: RequestOptions): Promise<InstallationResponse>;
  bootstrapSecrets(
    input: {
      throttleApiKey: string;
      webhookSigningSecret: string;
      replace: boolean;
    },
    options?: RequestOptions,
  ): Promise<{ status: InstallationResponse['status'] }>;
  getConnector(options?: RequestOptions): Promise<ConnectorResponse>;
  connectProvider(
    credentials: string,
    options?: RequestOptions,
  ): Promise<{ status: 'connected'; installationId: string }>;
  getConfiguration(options?: RequestOptions): Promise<ConfigurationResponse>;
  saveConfiguration(
    configuration: ConfigurationValue,
    options?: RequestOptions,
  ): Promise<{ status: 'updated' }>;
  getActivity(options?: RequestOptions): Promise<ActivityResponse>;
}

type ClientOptions = {
  baseUrl: string;
  mode: 'throttle' | 'local-mock';
  getToken(): string | null;
  refreshToken?: () => Promise<string>;
  fetcher?: typeof fetch;
};

function invalidBackendUrl(): never {
  throw new Error('Connector backend URL is invalid.');
}

function normalizeBaseUrl(value: string, mode: ClientOptions['mode']): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidBackendUrl();
  }
  if (
    url.origin !== value ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  )
    return invalidBackendUrl();
  if (url.protocol === 'https:') return url.origin;
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (mode === 'local-mock' && url.protocol === 'http:' && loopback)
    return url.origin;
  return invalidBackendUrl();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key) => actual.includes(key))
  );
}

function invalidResponse(): never {
  throw new ApiError({
    status: 502,
    code: 'INVALID_RESPONSE',
    message: 'The connector returned an invalid response.',
  });
}

const installationStatuses = new Set<InstallationResponse['status']>([
  'not_configured',
  'pending',
  'active',
  'disconnected',
  'uninstalled',
]);

function installationResponse(value: unknown): InstallationResponse {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['status']) ||
    typeof value.status !== 'string' ||
    !installationStatuses.has(value.status as InstallationResponse['status'])
  )
    return invalidResponse();
  return { status: value.status as InstallationResponse['status'] };
}

function connectorResponse(value: unknown): ConnectorResponse {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['status']) ||
    (value.status !== 'connected' && value.status !== 'not_connected')
  )
    return invalidResponse();
  return { status: value.status };
}

function configurationResponse(value: unknown): ConfigurationResponse {
  if (!isRecord(value) || !exactKeys(value, ['configuration']))
    return invalidResponse();
  if (
    value.configuration !== null &&
    !validateConfigurationValue(value.configuration)
  )
    return invalidResponse();
  return { configuration: value.configuration };
}

function activityResponse(value: unknown): ActivityResponse {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['activities']) ||
    !Array.isArray(value.activities)
  )
    return invalidResponse();
  const activities: Activity[] = [];
  for (const item of value.activities) {
    const parsed = activitySchema.safeParse(item);
    if (!parsed.success) return invalidResponse();
    activities.push(parsed.data);
  }
  return { activities };
}

function updatedResponse(value: unknown): { status: 'updated' } {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['status']) ||
    value.status !== 'updated'
  )
    return invalidResponse();
  return { status: 'updated' };
}

function connectedResponse(value: unknown): {
  status: 'connected';
  installationId: string;
} {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['status', 'installationId']) ||
    value.status !== 'connected' ||
    typeof value.installationId !== 'string' ||
    value.installationId.length === 0
  )
    return invalidResponse();
  return { status: 'connected', installationId: value.installationId };
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A stable fallback is safer than surfacing an upstream response body.
  }
  const detail =
    isRecord(body) && isRecord(body.error) ? body.error : undefined;
  return new ApiError({
    status: response.status,
    code: typeof detail?.code === 'string' ? detail.code : 'REQUEST_FAILED',
    message:
      typeof detail?.message === 'string'
        ? detail.message
        : 'The connector request could not be completed.',
    ...(typeof detail?.requestId === 'string'
      ? { requestId: detail.requestId }
      : {}),
  });
}

export function createBackendClient(options: ClientOptions): BackendClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl, options.mode);
  const fetcher = options.fetcher ?? fetch;
  const signalInit = (
    requestOptions: RequestOptions | undefined,
  ): Pick<RequestInit, 'signal'> =>
    requestOptions?.signal ? { signal: requestOptions.signal } : {};

  async function request<T>(
    path: string,
    parse: (value: unknown) => T,
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
      if (response.status === 401 && attempt === 0) {
        if (!options.refreshToken)
          throw new ApiError({
            status: 401,
            code: 'BRIDGE_REFRESH_UNAVAILABLE',
            message: 'The Throttle session could not be refreshed.',
          });
        await options.refreshToken();
        continue;
      }
      if (!response.ok) throw await errorFromResponse(response);
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        return invalidResponse();
      }
      return parse(value);
    }
    throw new Error('Unreachable authentication retry state');
  }

  return {
    getInstallation: (requestOptions) =>
      request('/api/installation', installationResponse, {
        ...signalInit(requestOptions),
      }),
    bootstrapSecrets: (input, requestOptions) =>
      request('/api/installation/secrets', installationResponse, {
        method: 'PUT',
        body: JSON.stringify(input),
        ...signalInit(requestOptions),
      }),
    getConnector: (requestOptions) =>
      request('/api/connector', connectorResponse, {
        ...signalInit(requestOptions),
      }),
    connectProvider: (credentials, requestOptions) =>
      request('/api/connector/credentials', connectedResponse, {
        method: 'PUT',
        body: JSON.stringify({ credentials }),
        ...signalInit(requestOptions),
      }),
    getConfiguration: (requestOptions) =>
      request('/api/connector/config', configurationResponse, {
        ...signalInit(requestOptions),
      }),
    saveConfiguration: (configuration, requestOptions) =>
      request('/api/connector/config', updatedResponse, {
        method: 'PUT',
        body: JSON.stringify(configuration),
        ...signalInit(requestOptions),
      }),
    getActivity: (requestOptions) =>
      request('/api/activity', activityResponse, {
        ...signalInit(requestOptions),
      }),
  };
}
