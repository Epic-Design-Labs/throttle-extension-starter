import { describe, expect, test, vi } from 'vitest';
import { ApiError, createBackendClient } from './api.js';

describe('publisher backend API client', () => {
  test('gets the current bridge token immediately before every request', async () => {
    const getToken = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('token-one')
      .mockReturnValueOnce('token-two');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: 'active' }))
      .mockResolvedValueOnce(Response.json({ status: 'not_connected' }));
    const client = createBackendClient({
      baseUrl: 'https://connector.example',
      mode: 'throttle',
      getToken,
      fetcher,
    });

    await client.getInstallation();
    await client.getConnector();

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://connector.example/api/installation',
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    );
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get('authorization'),
    ).toBe('Bearer token-one');
    expect(
      new Headers(fetcher.mock.calls[1]![1]?.headers).get('authorization'),
    ).toBe('Bearer token-two');
  });

  test('retries one 401 with a newly obtained token and no more', async () => {
    let token = 'expired';
    const getToken = vi.fn(() => token);
    const refreshToken = vi.fn(async () => {
      token = 'fresh';
      return token;
    });
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
      getToken,
      refreshToken,
      fetcher,
    });

    await expect(client.getInstallation()).resolves.toEqual({
      status: 'active',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(
      new Headers(fetcher.mock.calls[1]![1]?.headers).get('authorization'),
    ).toBe('Bearer fresh');
  });

  test('does not retry a second 401', async () => {
    const getToken = vi.fn(() => 'still-invalid');
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: {
            code: 'AUTHENTICATION_FAILED',
            message: 'Authentication failed.',
            requestId: 'request-1',
          },
        },
        { status: 401 },
      ),
    );
    const client = createBackendClient({
      baseUrl: 'https://connector.example',
      mode: 'throttle',
      getToken,
      refreshToken: vi.fn(async () => 'still-invalid'),
      fetcher,
    });

    await expect(client.getInstallation()).rejects.toMatchObject({
      status: 401,
      code: 'AUTHENTICATION_FAILED',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  test('fails before fetch when the bridge has no session token', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createBackendClient({
      baseUrl: 'https://connector.example',
      mode: 'throttle',
      getToken: () => null,
      fetcher,
    });

    await expect(client.getInstallation()).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('sends secrets only in authenticated request bodies without tenant authority', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ status: 'active' }))
      .mockResolvedValueOnce(
        Response.json({
          status: 'connected',
          installationId: 'installation-1',
        }),
      );
    const client = createBackendClient({
      baseUrl: 'https://connector.example',
      mode: 'throttle',
      getToken: () => 'bridge-token',
      fetcher,
    });

    await client.bootstrapSecrets({
      throttleApiKey: 'api-secret',
      webhookSigningSecret: 'signing-secret',
      replace: false,
    });
    await client.connectProvider('provider-secret');

    const bootstrapBody = JSON.parse(
      String(fetcher.mock.calls[0]![1]?.body),
    ) as Record<string, unknown>;
    const providerBody = JSON.parse(
      String(fetcher.mock.calls[1]![1]?.body),
    ) as Record<string, unknown>;
    expect(bootstrapBody).toEqual({
      throttleApiKey: 'api-secret',
      webhookSigningSecret: 'signing-secret',
      replace: false,
    });
    expect(providerBody).toEqual({ credentials: 'provider-secret' });
    expect(JSON.stringify([bootstrapBody, providerBody])).not.toContain(
      'installationId',
    );
  });

  test.each([
    ['throttle', 'https://connector.example'],
    ['local-mock', 'https://connector.example'],
    ['local-mock', 'http://localhost:8787'],
    ['local-mock', 'http://127.0.0.1:8787'],
    ['local-mock', 'http://[::1]:8787'],
  ] as const)('accepts %s backend origin %s', (mode, baseUrl) => {
    expect(() =>
      createBackendClient({
        baseUrl,
        mode,
        getToken: () => 'token',
        fetcher: vi.fn(),
      }),
    ).not.toThrow();
  });

  test.each([
    ['throttle', 'http://connector.example'],
    ['throttle', 'https://connector.example/'],
    ['throttle', 'https://user@connector.example'],
    ['throttle', 'https://connector.example/path'],
    ['throttle', 'https://connector.example?query=yes'],
    ['throttle', 'https://connector.example#fragment'],
    ['local-mock', 'http://connector.example'],
    ['local-mock', 'http://localhost.example:8787'],
  ] as const)('rejects %s backend URL %s', (mode, baseUrl) => {
    expect(() =>
      createBackendClient({
        baseUrl,
        mode,
        getToken: () => 'token',
        fetcher: vi.fn(),
      }),
    ).toThrowError('Connector backend URL is invalid.');
  });

  test('passes an AbortSignal through to fetch', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return Response.json({ status: 'active' });
    });
    const client = createBackendClient({
      baseUrl: 'https://connector.example',
      mode: 'throttle',
      getToken: () => 'token',
      fetcher,
    });

    await client.getInstallation({ signal: controller.signal });
  });

  test.each([
    ['installation status', '/api/installation', { status: 'surprise' }],
    [
      'connector status',
      '/api/connector',
      { status: 'connected', unexpected: true },
    ],
    [
      'unsafe configuration',
      '/api/connector/config',
      { configuration: { constructor: 'unsafe' } },
    ],
    [
      'activity date',
      '/api/activity',
      {
        activities: [
          {
            activityId: 'activity-1',
            installationId: 'installation-1',
            type: 'connector_sync',
            status: 'completed',
            result: 'success',
            attempt: 1,
            createdAt: 'not-a-date',
          },
        ],
      },
    ],
    [
      'activity result',
      '/api/activity',
      {
        activities: [
          {
            activityId: 'activity-1',
            installationId: 'installation-1',
            type: 'connector_sync',
            status: 'completed',
            result: 'secret_result',
            attempt: 1,
            createdAt: '2026-07-19T18:00:00.000Z',
          },
        ],
      },
    ],
  ] as const)(
    'rejects malformed %s responses safely',
    async (_name, path, body) => {
      const client = createBackendClient({
        baseUrl: 'https://connector.example',
        mode: 'throttle',
        getToken: () => 'token',
        fetcher: vi.fn(async () => Response.json(body)),
      });
      const operation =
        path === '/api/installation'
          ? client.getInstallation()
          : path === '/api/connector'
            ? client.getConnector()
            : path === '/api/connector/config'
              ? client.getConfiguration()
              : client.getActivity();

      await expect(operation).rejects.toMatchObject({
        status: 502,
        code: 'INVALID_RESPONSE',
        message: 'The connector returned an invalid response.',
      });
    },
  );

  test('uses a stable safe error for a malformed error response', async () => {
    const client = createBackendClient({
      baseUrl: 'https://connector.example',
      mode: 'throttle',
      getToken: () => 'token',
      fetcher: vi.fn(async () => Response.json(null, { status: 500 })),
    });

    await expect(client.getInstallation()).rejects.toMatchObject({
      status: 500,
      code: 'REQUEST_FAILED',
      message: 'The connector request could not be completed.',
    });
  });

  test.each([
    ['bootstrap', { status: 'active', extra: true }],
    ['connect', { status: 'connected' }],
    ['configuration mutation', { status: 'saved' }],
  ] as const)(
    'rejects malformed %s mutation responses',
    async (operation, body) => {
      const client = createBackendClient({
        baseUrl: 'https://connector.example',
        mode: 'throttle',
        getToken: () => 'token',
        fetcher: vi.fn(async () => Response.json(body)),
      });
      const result =
        operation === 'bootstrap'
          ? client.bootstrapSecrets({
              throttleApiKey: 'key',
              webhookSigningSecret: 'secret',
              replace: false,
            })
          : operation === 'connect'
            ? client.connectProvider('credential')
            : client.saveConfiguration({ syncMode: 'manual' });
      await expect(result).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    },
  );
});
