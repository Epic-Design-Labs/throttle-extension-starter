import { useState, type FormEvent } from 'react';

export function BootstrapPanel({
  onSubmit,
  busy,
  error,
}: {
  onSubmit(form: HTMLFormElement, replace: false): Promise<void>;
  busy: boolean;
  error?: string;
}) {
  return (
    <section className="panel setup-panel" aria-labelledby="bootstrap-heading">
      <p className="eyebrow">First run</p>
      <h2 id="bootstrap-heading">Secure installation setup</h2>
      <p>
        Enter the one-time values issued by Throttle. They are sent directly to
        the connector backend and are not saved by this page.
      </p>
      {error ? (
        <div role="alert" className="error-summary">
          {error}
        </div>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(event.currentTarget, false);
        }}
      >
        <label>
          One-time Throttle API key
          <input
            name="throttleApiKey"
            type="password"
            autoComplete="off"
            required
          />
        </label>
        <label>
          Webhook signing secret
          <input
            name="webhookSigningSecret"
            type="password"
            autoComplete="off"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save installation secrets'}
        </button>
      </form>
    </section>
  );
}

export function ProviderConnectionPanel({
  onSubmit,
  busy,
  error,
}: {
  onSubmit(form: HTMLFormElement): Promise<void>;
  busy: boolean;
  error?: string;
}) {
  return (
    <section className="panel setup-panel" aria-labelledby="provider-heading">
      <p className="eyebrow">Provider connection</p>
      <h2 id="provider-heading">Connect your provider</h2>
      <p>The credential is validated and encrypted by the connector backend.</p>
      {error ? (
        <div role="alert" className="error-summary">
          {error}
        </div>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onSubmit(event.currentTarget);
        }}
      >
        <label>
          Provider credential
          <input
            name="credentials"
            type="password"
            autoComplete="off"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect provider'}
        </button>
      </form>
    </section>
  );
}

export function RotationPanel({
  onSubmit,
  onCancel,
  busy,
  error,
}: {
  onSubmit(form: HTMLFormElement, replace: true): Promise<void>;
  onCancel(): void;
  busy: boolean;
  error?: string;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (confirmed) void onSubmit(event.currentTarget, true);
  };
  return (
    <section
      className="panel rotation-panel"
      aria-labelledby="rotation-heading"
    >
      <p className="eyebrow">Sensitive operation</p>
      <h2 id="rotation-heading">Rotate Throttle secrets</h2>
      <p>
        Event delivery using the previous signing secret will fail immediately
        after this rotation completes.
      </p>
      {error ? (
        <div role="alert" className="error-summary">
          {error}
        </div>
      ) : null}
      <form onSubmit={submit}>
        <label>
          Replacement Throttle API key
          <input
            name="throttleApiKey"
            type="password"
            autoComplete="off"
            required
          />
        </label>
        <label>
          Replacement webhook signing secret
          <input
            name="webhookSigningSecret"
            type="password"
            autoComplete="off"
            required
          />
        </label>
        <label className="confirmation">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
          />
          I understand the previous signing secret will stop working
        </label>
        <div className="button-row">
          <button
            type="submit"
            className="danger"
            disabled={!confirmed || busy}
          >
            {busy ? 'Rotating…' : 'Confirm secret rotation'}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
