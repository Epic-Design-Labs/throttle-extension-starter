import type { BridgeSessionContext } from '@usethrottle/extension-bridge';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App, type AppProps } from './App.js';
import {
  ApiError,
  type BackendClient,
  type ConnectorResponse,
  type InstallationResponse,
} from './api.js';
import type { ExtensionBridge } from './bridge.js';

const session: BridgeSessionContext = {
  user: { id: 'user-local', email: 'developer@example.test' },
  workspace: { id: 'workspace-local', slug: 'local-workspace' },
  application: { id: 'application-local', slug: 'local-application' },
  environment: {
    environmentId: 'environment-local',
    environmentSlug: 'test',
    environmentKind: 'non_production',
    providerEnvironment: 'sandbox',
  },
  installationId: 'installation-local',
  extensionId: 'extension-local',
  version: '0.0.0-local',
  role: 'admin',
  scopes: ['connector:read', 'connector:write'],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const installation = (
  status: InstallationResponse['status'],
): InstallationResponse => ({ status });
const connector = (status: ConnectorResponse['status']): ConnectorResponse => ({
  status,
});

function fixture(options?: {
  ready?: Promise<BridgeSessionContext>;
  mode?: ExtensionBridge['mode'];
  client?: Partial<BackendClient>;
  bridgeFactory?: AppProps['bridgeFactory'];
  backendFactory?: AppProps['backendFactory'];
}) {
  const bridge: ExtensionBridge = {
    ready: options?.ready ?? Promise.resolve(session),
    mode: options?.mode ?? 'throttle',
    getToken: vi.fn(() => 'token'),
    refreshToken: vi.fn(async () => 'token'),
    resize: vi.fn(),
    toast: vi.fn(),
    destroy: vi.fn(),
  };
  const client: BackendClient = {
    getInstallation: vi.fn(async () => installation('not_configured')),
    bootstrapSecrets: vi.fn(async () => ({ status: 'active' as const })),
    getConnector: vi.fn(async () => connector('not_connected')),
    connectProvider: vi.fn(async () => ({
      status: 'connected' as const,
      installationId: 'installation-local',
    })),
    getConfiguration: vi.fn(async () => ({ configuration: null })),
    saveConfiguration: vi.fn(async () => ({ status: 'updated' as const })),
    getActivity: vi.fn(async () => ({ activities: [] })),
    ...options?.client,
  };
  const bridgeFactory = options?.bridgeFactory ?? vi.fn(() => bridge);
  const backendFactory = options?.backendFactory ?? vi.fn(() => client);
  const view = render(
    <App bridgeFactory={bridgeFactory} backendFactory={backendFactory} />,
  );
  return { bridge, bridgeFactory, client, backendFactory, ...view };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('embedded connector management UI', () => {
  test('shows bridge loading and owns exactly one bridge lifecycle', async () => {
    const ready = deferred<BridgeSessionContext>();
    const { bridge, bridgeFactory, unmount } = fixture({
      ready: ready.promise,
    });

    expect(screen.getByRole('status')).toHaveTextContent(
      'Connecting to Throttle',
    );
    expect(bridgeFactory).toHaveBeenCalledOnce();
    ready.resolve(session);
    await screen.findByRole('heading', { name: 'Secure installation setup' });
    expect(bridgeFactory).toHaveBeenCalledOnce();
    await waitFor(() => expect(bridge.resize).toHaveBeenCalled());

    unmount();
    expect(bridge.destroy).toHaveBeenCalledOnce();
  });

  test('renders an invalid-host error when bridge configuration is rejected', () => {
    fixture({
      bridgeFactory: () => {
        throw new Error('unsafe host detail');
      },
    });

    expect(
      screen.getByRole('heading', { name: 'Unable to verify the host' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent(
      'unsafe host detail',
    );
  });

  test('destroys the bridge when backend host configuration is invalid', () => {
    const { bridge } = fixture({
      backendFactory: () => {
        throw new Error('invalid backend origin');
      },
    });

    expect(
      screen.getByRole('heading', { name: 'Unable to verify the host' }),
    ).toBeInTheDocument();
    expect(bridge.destroy).toHaveBeenCalledOnce();
  });

  test('submits one-time installation secrets transiently', async () => {
    const user = userEvent.setup();
    const getInstallation = vi
      .fn()
      .mockResolvedValueOnce(installation('not_configured'))
      .mockResolvedValueOnce(installation('active'));
    const { bridge, client } = fixture({
      mode: 'local-mock',
      client: { getInstallation },
    });
    const apiSecret = 'api-never-persist-me';
    const signingSecret = 'signing-never-persist-me';
    expect(await screen.findByText('Local mock session')).toBeVisible();
    const apiInput = screen.getByLabelText('One-time Throttle API key');
    const signingInput = screen.getByLabelText('Webhook signing secret');
    expect(apiInput).toHaveAttribute('type', 'password');
    expect(signingInput).toHaveAttribute('type', 'password');
    await user.type(apiInput, apiSecret);
    await user.type(signingInput, signingSecret);
    await user.click(
      screen.getByRole('button', { name: 'Save installation secrets' }),
    );

    await waitFor(() =>
      expect(client.bootstrapSecrets).toHaveBeenCalledWith(
        {
          throttleApiKey: apiSecret,
          webhookSigningSecret: signingSecret,
          replace: false,
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
    await screen.findByRole('heading', { name: 'Connect your provider' });
    expect(document.body).not.toHaveTextContent(apiSecret);
    expect(document.body).not.toHaveTextContent(signingSecret);
    expect(JSON.stringify(localStorage)).not.toContain(apiSecret);
    expect(JSON.stringify(sessionStorage)).not.toContain(signingSecret);
    expect(bridge.toast).toHaveBeenCalledWith(
      'Installation secrets saved.',
      'success',
    );
  });

  test('submits provider credentials transiently and displays connected state', async () => {
    const user = userEvent.setup();
    const getConnector = vi
      .fn()
      .mockResolvedValueOnce(connector('not_connected'))
      .mockResolvedValueOnce(connector('connected'));
    const { bridge, client } = fixture({
      client: {
        getInstallation: vi.fn(async () => installation('active')),
        getConnector,
      },
    });
    const credential = 'provider-never-persist-me';
    await screen.findByRole('heading', { name: 'Connect your provider' });
    const input = screen.getByLabelText('Provider credential');
    expect(input).toHaveAttribute('type', 'password');
    await user.type(input, credential);
    await user.click(screen.getByRole('button', { name: 'Connect provider' }));

    await waitFor(() =>
      expect(client.connectProvider).toHaveBeenCalledWith(credential, {
        signal: expect.any(AbortSignal),
      }),
    );
    await screen.findByRole('heading', { name: 'Connector status' });
    expect(screen.getByText('Connected')).toBeVisible();
    expect(document.body).not.toHaveTextContent(credential);
    expect(JSON.stringify(localStorage)).not.toContain(credential);
    expect(JSON.stringify(sessionStorage)).not.toContain(credential);
    expect(bridge.toast).toHaveBeenCalledWith('Provider connected.', 'success');
  });

  test('resizes for action errors and does not toast failed actions', async () => {
    const user = userEvent.setup();
    let height = 320;
    vi.spyOn(
      document.documentElement,
      'scrollHeight',
      'get',
    ).mockImplementation(() => height);
    const { bridge } = fixture({
      client: {
        getInstallation: vi.fn(async () => installation('active')),
        connectProvider: vi.fn(async () => {
          throw new ApiError({
            status: 422,
            code: 'PROVIDER_REJECTED',
            message: 'The provider rejected the credential.',
          });
        }),
      },
    });
    await screen.findByRole('heading', { name: 'Connect your provider' });
    await waitFor(() => expect(bridge.resize).toHaveBeenCalled());
    const resizeCount = vi.mocked(bridge.resize).mock.calls.length;
    await user.type(
      screen.getByLabelText('Provider credential'),
      'rejected-secret',
    );
    height = 480;
    await user.click(screen.getByRole('button', { name: 'Connect provider' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The provider rejected the credential.',
    );
    expect(bridge.toast).not.toHaveBeenCalled();
    expect(bridge.resize).toHaveBeenCalledTimes(resizeCount + 1);
    expect(document.body).not.toHaveTextContent('rejected-secret');
  });

  test('observes, debounces, deduplicates, and cleans meaningful resizes', async () => {
    let callback!: ResizeObserverCallback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class FakeResizeObserver {
      constructor(next: ResizeObserverCallback) {
        callback = next;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    let height = 400;
    vi.spyOn(
      document.documentElement,
      'scrollHeight',
      'get',
    ).mockImplementation(() => height);
    const { bridge, unmount } = fixture();
    await screen.findByRole('heading', { name: 'Secure installation setup' });
    await waitFor(() =>
      expect(observe).toHaveBeenCalledWith(document.documentElement),
    );
    await waitFor(() => expect(bridge.resize).toHaveBeenCalledWith(400));
    vi.mocked(bridge.resize).mockClear();

    height = 640;
    callback([], {} as ResizeObserver);
    callback([], {} as ResizeObserver);
    await waitFor(() => expect(bridge.resize).toHaveBeenCalledTimes(1));
    expect(bridge.resize).toHaveBeenCalledWith(640);
    callback([], {} as ResizeObserver);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(bridge.resize).toHaveBeenCalledTimes(1);

    unmount();
    expect(disconnect).toHaveBeenCalledOnce();
    height = 800;
    callback([], {} as ResizeObserver);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(bridge.resize).toHaveBeenCalledTimes(1);
  });

  test('shows connected configuration, environment, and sanitized recent activity', async () => {
    fixture({
      client: {
        getInstallation: vi.fn(async () => installation('active')),
        getConnector: vi.fn(async () => connector('connected')),
        getConfiguration: vi.fn(async () => ({
          configuration: { syncMode: 'automatic' },
        })),
        getActivity: vi.fn(async () => ({
          activities: [
            {
              activityId: 'activity-1',
              installationId: 'installation-local',
              eventId: 'event-1',
              type: 'connector_sync' as const,
              status: 'completed' as const,
              result: 'success' as const,
              attempt: 1,
              message: 'Order synchronized.',
              createdAt: '2026-07-19T18:00:00.000Z',
            },
          ],
        })),
      },
    });

    await screen.findByRole('heading', { name: 'Connector status' });
    expect(screen.getByText('Test · sandbox')).toBeVisible();
    expect(screen.getByLabelText('Connector configuration')).toHaveValue(
      '{\n  "syncMode": "automatic"\n}',
    );
    const activity = screen.getByRole('list', { name: 'Recent activity' });
    expect(within(activity).getByText('Order synchronized.')).toBeVisible();
    expect(within(activity).getByText('Success')).toBeVisible();
  });

  test.each([
    [
      'retryable_failure',
      'Will retry',
      'The connector will retry automatically.',
    ],
    [
      'terminal_failure',
      'Needs attention',
      'Review the connector credentials and configuration.',
    ],
  ] as const)(
    'explains %s activity without exposing secret fields',
    async (result, label, guidance) => {
      fixture({
        client: {
          getInstallation: vi.fn(async () => installation('active')),
          getConnector: vi.fn(async () => connector('connected')),
          getActivity: vi.fn(async () => ({
            activities: [
              {
                activityId: 'activity-1',
                installationId: 'installation-local',
                type: 'connector_sync' as const,
                status: 'completed' as const,
                result,
                attempt: 2,
                message: 'Safe provider summary.',
                code:
                  result === 'retryable_failure'
                    ? 'PROVIDER_BUSY'
                    : 'CREDENTIAL_REJECTED',
                createdAt: '2026-07-19T18:00:00.000Z',
              },
            ],
          })),
        },
      });

      await screen.findByRole('heading', { name: 'Connector status' });
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.getByText(guidance)).toBeVisible();
      expect(document.body).not.toHaveTextContent('installation-local');
    },
  );

  test('requires explicit confirmation before rotating signing secrets', async () => {
    const user = userEvent.setup();
    const { bridge, client } = fixture({
      client: {
        getInstallation: vi.fn(async () => installation('active')),
        getConnector: vi.fn(async () => connector('connected')),
      },
    });
    await screen.findByRole('heading', { name: 'Connector status' });
    await user.click(
      screen.getByRole('button', { name: 'Rotate Throttle secrets' }),
    );
    const submit = screen.getByRole('button', {
      name: 'Confirm secret rotation',
    });
    expect(submit).toBeDisabled();
    await user.type(
      screen.getByLabelText('Replacement Throttle API key'),
      'new-api-secret',
    );
    await user.type(
      screen.getByLabelText('Replacement webhook signing secret'),
      'new-signing-secret',
    );
    await user.click(
      screen.getByLabelText(
        'I understand the previous signing secret will stop working',
      ),
    );
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(client.bootstrapSecrets).toHaveBeenCalledWith(
        {
          throttleApiKey: 'new-api-secret',
          webhookSigningSecret: 'new-signing-secret',
          replace: true,
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(
      screen.queryByLabelText('Replacement Throttle API key'),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('new-signing-secret');
    expect(bridge.toast).toHaveBeenCalledWith(
      'Throttle secrets rotated.',
      'success',
    );
  });

  test('shows a retryable bridge refresh error and can retry the load', async () => {
    const user = userEvent.setup();
    const getInstallation = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError({
          status: 503,
          code: 'BRIDGE_REFRESH_FAILED',
          message: 'The Throttle session could not be refreshed.',
          requestId: 'request-1',
        }),
      )
      .mockResolvedValueOnce(installation('not_configured'));
    fixture({ client: { getInstallation } });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'could not be refreshed',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Secure installation setup' });
    expect(getInstallation).toHaveBeenCalledTimes(2);
  });

  test('aborts an in-flight load on unmount and ignores its continuation', async () => {
    const pending = deferred<InstallationResponse>();
    const getInstallation = vi.fn<BackendClient['getInstallation']>(
      () => pending.promise,
    );
    const { bridge, unmount } = fixture({ client: { getInstallation } });
    await waitFor(() => expect(getInstallation).toHaveBeenCalledOnce());
    const signal = getInstallation.mock.calls[0]![0]?.signal;
    signal?.addEventListener('abort', () =>
      pending.reject(new DOMException('aborted', 'AbortError')),
    );

    unmount();
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(bridge.toast).not.toHaveBeenCalled();
  });

  test('keeps a newer load when an older generation resolves later', async () => {
    const staleInstallation = deferred<InstallationResponse>();
    const first = fixture({
      client: {
        getInstallation: vi.fn(() => staleInstallation.promise),
      },
    });
    await waitFor(() =>
      expect(first.client.getInstallation).toHaveBeenCalledOnce(),
    );
    const nextBridge: ExtensionBridge = {
      ...first.bridge,
      ready: Promise.resolve(session),
      destroy: vi.fn(),
    };
    const nextClient: BackendClient = {
      ...first.client,
      getInstallation: vi.fn(async () => installation('not_configured')),
    };
    const nextBridgeFactory = () => nextBridge;
    const nextBackendFactory = () => nextClient;
    first.rerender(
      <App
        bridgeFactory={nextBridgeFactory}
        backendFactory={nextBackendFactory}
      />,
    );
    await screen.findByRole('heading', { name: 'Secure installation setup' });

    staleInstallation.resolve(installation('active'));
    await Promise.resolve();
    await Promise.resolve();
    expect(first.client.getConnector).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', { name: 'Secure installation setup' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Connect your provider' }),
    ).not.toBeInTheDocument();
  });

  test('aborts an in-flight action on unmount without a stale toast', async () => {
    const user = userEvent.setup();
    const pending = deferred<{
      status: 'connected';
      installationId: string;
    }>();
    const connectProvider = vi.fn<BackendClient['connectProvider']>(
      () => pending.promise,
    );
    const { bridge, unmount } = fixture({
      client: {
        getInstallation: vi.fn(async () => installation('active')),
        connectProvider,
      },
    });
    await screen.findByRole('heading', { name: 'Connect your provider' });
    await user.type(screen.getByLabelText('Provider credential'), 'credential');
    await user.click(screen.getByRole('button', { name: 'Connect provider' }));
    await waitFor(() => expect(connectProvider).toHaveBeenCalledOnce());
    const signal = connectProvider.mock.calls[0]![1]?.signal;

    unmount();
    expect(signal?.aborted).toBe(true);
    pending.resolve({
      status: 'connected',
      installationId: 'installation-local',
    });
    await Promise.resolve();
    expect(bridge.toast).not.toHaveBeenCalled();
  });

  test('fences an older overlapping action from state and toast', async () => {
    const first = deferred<{
      status: 'connected';
      installationId: string;
    }>();
    const second = deferred<{
      status: 'connected';
      installationId: string;
    }>();
    const connectProvider = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const getConnector = vi
      .fn()
      .mockResolvedValueOnce(connector('not_connected'))
      .mockResolvedValue(connector('connected'));
    const { bridge } = fixture({
      client: {
        getInstallation: vi.fn(async () => installation('active')),
        getConnector,
        connectProvider,
      },
    });
    await screen.findByRole('heading', { name: 'Connect your provider' });
    const input = screen.getByLabelText('Provider credential');
    const form = input.closest('form');
    if (!form) throw new Error('Expected provider form');
    fireEvent.change(input, { target: { value: 'first-secret' } });
    fireEvent.submit(form);
    await waitFor(() => expect(connectProvider).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'second-secret' } });
    fireEvent.submit(form);
    await waitFor(() => expect(connectProvider).toHaveBeenCalledTimes(2));
    expect(connectProvider.mock.calls[0]![1].signal.aborted).toBe(true);

    second.resolve({
      status: 'connected',
      installationId: 'installation-local',
    });
    await screen.findByRole('heading', { name: 'Connector status' });
    expect(bridge.toast).toHaveBeenCalledTimes(1);
    first.resolve({
      status: 'connected',
      installationId: 'installation-local',
    });
    await Promise.resolve();
    expect(bridge.toast).toHaveBeenCalledTimes(1);
  });

  test('announces completed configuration saves but not failed actions', async () => {
    const user = userEvent.setup();
    const { bridge, client } = fixture({
      client: {
        getInstallation: vi.fn(async () => installation('active')),
        getConnector: vi.fn(async () => connector('connected')),
      },
    });
    await screen.findByRole('heading', { name: 'Connector status' });
    const editor = screen.getByLabelText('Connector configuration');
    fireEvent.change(editor, { target: { value: '{"syncMode":"manual"}' } });
    await user.click(
      screen.getByRole('button', { name: 'Save configuration' }),
    );

    await waitFor(() =>
      expect(client.saveConfiguration).toHaveBeenCalledWith(
        { syncMode: 'manual' },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(bridge.toast).toHaveBeenCalledWith(
      'Configuration saved.',
      'success',
    );
  });
});
