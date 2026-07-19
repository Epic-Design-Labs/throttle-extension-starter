import {
  validateConfigurationValue,
  type Activity,
  type ConfigurationValue,
} from '@starter/contracts';
import type { BridgeSessionContext } from '@usethrottle/extension-bridge';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, createBackendClient, type BackendClient } from './api.js';
import { createExtensionBridge, type ExtensionBridge } from './bridge.js';
import { ActivityList } from './components/ActivityList.js';
import {
  BootstrapPanel,
  ProviderConnectionPanel,
  RotationPanel,
} from './components/ConnectionPanel.js';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'bootstrap' }
  | { kind: 'disconnected' }
  | {
      kind: 'connected';
      configuration: ConfigurationValue | null;
      activities: Activity[];
    }
  | { kind: 'invalid_host' }
  | { kind: 'error'; message: string; retryable: boolean };

export interface AppProps {
  bridgeFactory?: () => ExtensionBridge;
  backendFactory?: (bridge: ExtensionBridge) => BackendClient;
}

const defaultBackendFactory = (bridge: ExtensionBridge) =>
  createBackendClient({
    baseUrl: import.meta.env.VITE_CONNECTOR_API_ORIGIN,
    mode: bridge.mode,
    getToken: () => bridge.getToken(),
    refreshToken: () => bridge.refreshToken(),
  });

function publicError(error: unknown) {
  if (error instanceof ApiError)
    return { message: error.message, retryable: error.retryable };
  return {
    message: 'The connector could not load. Please reopen the extension.',
    retryable: false,
  };
}

function formSecret(form: HTMLFormElement, name: string): string {
  const value = new FormData(form).get(name);
  return typeof value === 'string' ? value : '';
}

function environmentLabel(context: BridgeSessionContext) {
  const slug = context.environment.environmentSlug;
  const title = slug.charAt(0).toUpperCase() + slug.slice(1);
  return `${title} · ${context.environment.providerEnvironment}`;
}

function ConfigurationPanel({
  value,
  onSave,
  busy,
  error,
}: {
  value: ConfigurationValue | null;
  onSave(value: unknown): Promise<void>;
  busy: boolean;
  error?: string;
}) {
  const [editor, setEditor] = useState(() =>
    JSON.stringify(value ?? {}, null, 2),
  );
  const [parseError, setParseError] = useState<string>();
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(editor) as unknown;
    } catch {
      setParseError('Configuration must be valid JSON.');
      return;
    }
    if (!validateConfigurationValue(parsed)) {
      setParseError('Configuration must contain safe JSON values.');
      return;
    }
    setParseError(undefined);
    void onSave(parsed);
  };
  return (
    <section className="panel" aria-labelledby="configuration-heading">
      <p className="eyebrow">Non-secret settings</p>
      <h2 id="configuration-heading">Configuration</h2>
      <p>Only display-safe connector settings belong here.</p>
      {parseError || error ? (
        <div role="alert" className="error-summary">
          {parseError ?? error}
        </div>
      ) : null}
      <form onSubmit={submit}>
        <label>
          Connector configuration
          <textarea
            value={editor}
            onChange={(event) => setEditor(event.currentTarget.value)}
            rows={8}
            spellCheck={false}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save configuration'}
        </button>
      </form>
    </section>
  );
}

export function App({
  bridgeFactory = createExtensionBridge,
  backendFactory = defaultBackendFactory,
}: AppProps) {
  const bridgeRef = useRef<ExtensionBridge | undefined>(undefined);
  const clientRef = useRef<BackendClient | undefined>(undefined);
  const mountedRef = useRef(false);
  const operationRef = useRef<
    { generation: number; controller: AbortController } | undefined
  >(undefined);
  const generationRef = useRef(0);
  const scheduleResizeRef = useRef<() => void>(() => undefined);
  const [session, setSession] = useState<BridgeSessionContext>();
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [rotationOpen, setRotationOpen] = useState(false);

  const beginOperation = () => {
    operationRef.current?.controller.abort();
    const operation = {
      generation: ++generationRef.current,
      controller: new AbortController(),
    };
    operationRef.current = operation;
    return operation;
  };

  const isCurrent = (operation: {
    generation: number;
    controller: AbortController;
  }) =>
    mountedRef.current &&
    operationRef.current?.generation === operation.generation &&
    !operation.controller.signal.aborted;

  const load = async (
    client: BackendClient,
    operation: { generation: number; controller: AbortController },
  ) => {
    if (!isCurrent(operation)) return;
    setActionError(undefined);
    const requestOptions = { signal: operation.controller.signal };
    const installation = await client.getInstallation(requestOptions);
    if (!isCurrent(operation)) return;
    if (installation.status === 'not_configured') {
      setView({ kind: 'bootstrap' });
      return;
    }
    if (installation.status !== 'active') {
      setView({
        kind: 'error',
        message: 'This installation is not active.',
        retryable: false,
      });
      return;
    }
    const connector = await client.getConnector(requestOptions);
    if (!isCurrent(operation)) return;
    if (connector.status === 'not_connected') {
      setView({ kind: 'disconnected' });
      return;
    }
    const [configuration, activity] = await Promise.all([
      client.getConfiguration(requestOptions),
      client.getActivity(requestOptions),
    ]);
    if (!isCurrent(operation)) return;
    setView({
      kind: 'connected',
      configuration: configuration.configuration,
      activities: activity.activities,
    });
  };

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    let bridge: ExtensionBridge | undefined;
    let client: BackendClient;
    try {
      bridge = bridgeFactory();
      client = backendFactory(bridge);
    } catch {
      bridge?.destroy();
      setView({ kind: 'invalid_host' });
      return;
    }
    bridgeRef.current = bridge;
    clientRef.current = client;
    const operation = beginOperation();
    setView({ kind: 'loading' });
    void bridge.ready
      .then(async (context) => {
        if (!active || !isCurrent(operation)) return;
        setSession(context);
        await load(client, operation);
      })
      .catch((error: unknown) => {
        if (!active || !isCurrent(operation)) return;
        const safe = publicError(error);
        setView({ kind: 'error', ...safe });
      });
    return () => {
      active = false;
      mountedRef.current = false;
      operationRef.current?.controller.abort();
      operationRef.current = undefined;
      generationRef.current++;
      bridge.destroy();
      bridgeRef.current = undefined;
      clientRef.current = undefined;
    };
  }, [backendFactory, bridgeFactory]);

  useEffect(() => {
    if (!session) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastHeight: number | undefined;
    const schedule = () => {
      if (stopped) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (stopped) return;
        const height = Math.max(
          document.documentElement.scrollHeight,
          document.body.scrollHeight,
          320,
        );
        if (height === lastHeight) return;
        lastHeight = height;
        bridgeRef.current?.resize(height);
      }, 0);
    };
    scheduleResizeRef.current = schedule;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(schedule);
    observer?.observe(document.documentElement);
    schedule();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
      scheduleResizeRef.current = () => undefined;
    };
  }, [session]);

  useEffect(() => {
    scheduleResizeRef.current();
  }, [actionError, rotationOpen, view]);

  const reload = async () => {
    const client = clientRef.current;
    if (!client) return;
    const operation = beginOperation();
    setView({ kind: 'loading' });
    try {
      await load(client, operation);
    } catch (error) {
      if (!isCurrent(operation)) return;
      setView({ kind: 'error', ...publicError(error) });
    }
  };

  const submitSecrets = async (form: HTMLFormElement, replace: boolean) => {
    const client = clientRef.current;
    if (!client) return;
    const operation = beginOperation();
    setBusy(true);
    setActionError(undefined);
    const input = {
      throttleApiKey: formSecret(form, 'throttleApiKey'),
      webhookSigningSecret: formSecret(form, 'webhookSigningSecret'),
      replace,
    };
    form.reset();
    try {
      await client.bootstrapSecrets(input, {
        signal: operation.controller.signal,
      });
      if (!isCurrent(operation)) return;
      bridgeRef.current?.toast(
        replace ? 'Throttle secrets rotated.' : 'Installation secrets saved.',
        'success',
      );
      setRotationOpen(false);
      await load(client, operation);
    } catch (error) {
      if (!isCurrent(operation)) return;
      setActionError(publicError(error).message);
    } finally {
      if (isCurrent(operation)) setBusy(false);
    }
  };

  const submitProvider = async (form: HTMLFormElement) => {
    const client = clientRef.current;
    if (!client) return;
    const operation = beginOperation();
    setBusy(true);
    setActionError(undefined);
    const credentials = formSecret(form, 'credentials');
    form.reset();
    try {
      await client.connectProvider(credentials, {
        signal: operation.controller.signal,
      });
      if (!isCurrent(operation)) return;
      bridgeRef.current?.toast('Provider connected.', 'success');
      await load(client, operation);
    } catch (error) {
      if (!isCurrent(operation)) return;
      setActionError(publicError(error).message);
    } finally {
      if (isCurrent(operation)) setBusy(false);
    }
  };

  const saveConfiguration = async (configuration: unknown) => {
    const client = clientRef.current;
    if (!client || !validateConfigurationValue(configuration)) return;
    const operation = beginOperation();
    setBusy(true);
    setActionError(undefined);
    try {
      await client.saveConfiguration(configuration, {
        signal: operation.controller.signal,
      });
      if (!isCurrent(operation)) return;
      bridgeRef.current?.toast('Configuration saved.', 'success');
    } catch (error) {
      if (!isCurrent(operation)) return;
      setActionError(publicError(error).message);
    } finally {
      if (isCurrent(operation)) setBusy(false);
    }
  };

  if (view.kind === 'invalid_host')
    return (
      <main className="shell narrow">
        <section className="panel error-panel" role="alert">
          <p className="eyebrow">Security check failed</p>
          <h1>Unable to verify the host</h1>
          <p>Open this extension from the configured Throttle dashboard.</p>
        </section>
      </main>
    );

  return (
    <main className="shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Throttle extension</p>
          <h1>Connector management</h1>
          {session ? (
            <p className="context">
              {session.workspace.slug} / {session.application.slug}
            </p>
          ) : null}
        </div>
        {session ? (
          <div className="badges" aria-label="Current environment">
            <span className="badge">{environmentLabel(session)}</span>
            {bridgeRef.current?.mode === 'local-mock' ? (
              <span className="badge mock">Local mock session</span>
            ) : null}
          </div>
        ) : null}
      </header>

      {view.kind === 'loading' ? (
        <section className="panel loading" role="status">
          <span className="spinner" aria-hidden="true" />
          <div>
            <h2>Connecting to Throttle</h2>
            <p>Verifying the embedded session…</p>
          </div>
        </section>
      ) : null}

      {view.kind === 'bootstrap' ? (
        <BootstrapPanel
          onSubmit={submitSecrets}
          busy={busy}
          {...(actionError ? { error: actionError } : {})}
        />
      ) : null}

      {view.kind === 'disconnected' ? (
        <ProviderConnectionPanel
          onSubmit={submitProvider}
          busy={busy}
          {...(actionError ? { error: actionError } : {})}
        />
      ) : null}

      {view.kind === 'connected' ? (
        <>
          <section
            className="panel status-panel"
            aria-labelledby="status-heading"
          >
            <div>
              <p className="eyebrow">Connection</p>
              <h2 id="status-heading">Connector status</h2>
              <p className="connected">
                <span aria-hidden="true" />
                Connected
              </p>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => setRotationOpen(true)}
            >
              Rotate Throttle secrets
            </button>
          </section>
          {rotationOpen ? (
            <RotationPanel
              onSubmit={submitSecrets}
              onCancel={() => setRotationOpen(false)}
              busy={busy}
              {...(actionError ? { error: actionError } : {})}
            />
          ) : null}
          <div className="grid">
            <ConfigurationPanel
              value={view.configuration}
              onSave={saveConfiguration}
              busy={busy}
              {...(actionError ? { error: actionError } : {})}
            />
            <ActivityList activities={view.activities} />
          </div>
        </>
      ) : null}

      {view.kind === 'error' ? (
        <section className="panel error-panel" role="alert">
          <p className="eyebrow">
            {view.retryable ? 'Temporary interruption' : 'Action required'}
          </p>
          <h2>Connector unavailable</h2>
          <p>{view.message}</p>
          {view.retryable ? (
            <button type="button" onClick={() => void reload()}>
              Try again
            </button>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}
