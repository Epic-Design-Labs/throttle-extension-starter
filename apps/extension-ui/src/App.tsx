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
    getToken: () => bridge.getToken(),
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
  const [session, setSession] = useState<BridgeSessionContext>();
  const [view, setView] = useState<ViewState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [rotationOpen, setRotationOpen] = useState(false);

  const load = async (client: BackendClient) => {
    setActionError(undefined);
    const installation = await client.getInstallation();
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
    const connector = await client.getConnector();
    if (connector.status === 'not_connected') {
      setView({ kind: 'disconnected' });
      return;
    }
    const [configuration, activity] = await Promise.all([
      client.getConfiguration(),
      client.getActivity(),
    ]);
    setView({
      kind: 'connected',
      configuration: configuration.configuration,
      activities: activity.activities,
    });
  };

  useEffect(() => {
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
    void bridge.ready
      .then(async (context) => {
        if (!active) return;
        setSession(context);
        await load(client);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const safe = publicError(error);
        setView({ kind: 'error', ...safe });
      });
    return () => {
      active = false;
      bridge.destroy();
      bridgeRef.current = undefined;
      clientRef.current = undefined;
    };
  }, [backendFactory, bridgeFactory]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    const height = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      320,
    );
    bridge.resize(height);
  }, [actionError, rotationOpen, view]);

  const reload = async () => {
    const client = clientRef.current;
    if (!client) return;
    setView({ kind: 'loading' });
    try {
      await load(client);
    } catch (error) {
      setView({ kind: 'error', ...publicError(error) });
    }
  };

  const submitSecrets = async (form: HTMLFormElement, replace: boolean) => {
    const client = clientRef.current;
    if (!client) return;
    setBusy(true);
    setActionError(undefined);
    const request = client.bootstrapSecrets({
      throttleApiKey: formSecret(form, 'throttleApiKey'),
      webhookSigningSecret: formSecret(form, 'webhookSigningSecret'),
      replace,
    });
    form.reset();
    try {
      await request;
      bridgeRef.current?.toast(
        replace ? 'Throttle secrets rotated.' : 'Installation secrets saved.',
        'success',
      );
      setRotationOpen(false);
      await reload();
    } catch (error) {
      setActionError(publicError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitProvider = async (form: HTMLFormElement) => {
    const client = clientRef.current;
    if (!client) return;
    setBusy(true);
    setActionError(undefined);
    const request = client.connectProvider(formSecret(form, 'credentials'));
    form.reset();
    try {
      await request;
      bridgeRef.current?.toast('Provider connected.', 'success');
      await reload();
    } catch (error) {
      setActionError(publicError(error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveConfiguration = async (configuration: unknown) => {
    const client = clientRef.current;
    if (!client || !validateConfigurationValue(configuration)) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await client.saveConfiguration(configuration);
      bridgeRef.current?.toast('Configuration saved.', 'success');
    } catch (error) {
      setActionError(publicError(error).message);
    } finally {
      setBusy(false);
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
