import { describe, expect, test, vi } from 'vitest';
import { ApiError, createBackendClient } from './api.js';

describe('publisher backend API client', () => {
  test('gets the current bridge token immediately before every request', async () => {
    const getToken = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('token-one')
      .mockReturnValueOnce('token-two');
    const fetcher = vi.fn<typeof fetch>(async (_input, init) =>
      Response.json({
        authorization: new Headers(init?.headers).get('authorization'),
      }),
    );
    const client = createBackendClient({
      baseUrl: 'https://connector.example',
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
    const getToken = vi
      .fn<() => string | null>()
      .mockReturnValueOnce('expired')
      .mockReturnValueOnce('fresh');
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
      baseUrl: 'https://connector.example/',
      getToken,
      fetcher,
    });

    await expect(client.getInstallation()).resolves.toEqual({
      status: 'active',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(getToken).toHaveBeenCalledTimes(2);
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
      getToken,
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
      getToken: () => null,
      fetcher,
    });

    await expect(client.getInstallation()).rejects.toBeInstanceOf(ApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('sends secrets only in authenticated request bodies without tenant authority', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ status: 'active' }),
    );
    const client = createBackendClient({
      baseUrl: 'https://connector.example',
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
});
