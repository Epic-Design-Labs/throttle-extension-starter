# Architecture

This starter implements a Throttle **hybrid extension**: an embedded React
iframe UI plus a backend Worker. This document explains how the pieces fit
together and why the package boundaries exist. For "what do I run and in
what order," see [local-development.md](local-development.md); for "what do
I change to ship my own integration," see
[adding-a-provider.md](adding-a-provider.md).

## Two runtime surfaces

```
Throttle Dashboard (parent frame)
        │  postMessage bridge (session token, resize, toast)
        ▼
apps/extension-ui  (React, Vite, iframe)
        │  HTTPS + Bearer <extension identity JWT>
        ▼
apps/cloudflare     (Hono app on a Cloudflare Worker)
        │
        ├── D1 (installations, secrets, configurations, jobs, activities, deliveries)
        └── Cloudflare Queue (connector job dispatch)
        │
        ▼
examples/demo-connector  (replace with your real ProviderConnector)
```

- **`apps/extension-ui`** renders inside an iframe on the Throttle dashboard.
  It talks to the dashboard only through the `@usethrottle/extension-bridge`
  `postMessage` protocol (session token issuance/refresh, resize, toast) and
  talks to the Worker only through the JSON HTTP API under `/api/*`.
- **`apps/cloudflare`** is the Worker: an HTTP app (`src/app.ts`) for the
  iframe's API calls and the Throttle webhook endpoint, plus a queue
  consumer (`src/composition/index.ts` → `createQueueEntrypoint`) that
  processes accepted events against your provider.

## Package layout and why the boundary matters

| Package                              | Depends on runtime?      | Purpose                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`                 | No                       | `zod` `.strict()` schemas and TypeScript types shared by every layer: `Installation`, `ThrottleEvent`, `ConnectorJob`, `Activity`, configuration validation. camelCase only — this is the wire contract.                                                                                                                  |
| `packages/core`                      | No                       | Runtime-agnostic business logic: `connectProvider`, `processConnectorEvent`, retry/backoff policy, typed `AppError`s, and the _ports_ (`InstallationStore`, `CredentialStore`, `ConfigurationStore`, `ActivityStore`, `JobExecutionStore`, `ProviderConnector`, `Logger`, `Clock`) that a runtime adapter must implement. |
| `packages/security`                  | No (Web Crypto only)     | AES-256-GCM credential encryption and structured-log redaction. Built on the standard `crypto.subtle` API so it runs unchanged on Workers, Node, or any other runtime with Web Crypto.                                                                                                                                    |
| `packages/throttle`                  | No (Web Crypto + `jose`) | Webhook signature verification (raw-body HMAC) and identity JWT verification against the Throttle JWKS.                                                                                                                                                                                                                   |
| `packages/adapters-d1`               | Cloudflare D1            | Implements the `core` ports against D1: installations, secrets, configurations, activities, job execution leasing, webhook delivery/idempotency, atomic bootstrap and uninstall.                                                                                                                                          |
| `packages/adapters-cloudflare-queue` | Cloudflare Queues        | Producer (enqueue a `ConnectorJob`) and consumer (drain a message batch, translate `core`'s retry/terminal results into Cloudflare Queue `ack`/`retry`).                                                                                                                                                                  |
| `apps/cloudflare`                    | Cloudflare Workers       | Composes everything above into one deployable Worker: the Hono HTTP app, environment validation, and the queue entrypoint.                                                                                                                                                                                                |
| `apps/extension-ui`                  | Browser (iframe)         | The embedded React UI: bootstrap/connect/configure/activity screens, the bridge integration, and a typed backend client.                                                                                                                                                                                                  |
| `examples/demo-connector`            | No                       | A deterministic fictional `ProviderConnector` used by the reference end-to-end test and as the template's default provider. Replace it (see [adding-a-provider.md](adding-a-provider.md)).                                                                                                                                |

`packages/contracts/src` and `packages/core/src` are enforced (by
`tests/workspace-boundaries.test.ts`) to have **zero runtime imports** — no
`node:*`, `cloudflare:*`, `@cloudflare/*`, `react*`, `postgres*`, or
`wrangler*`. That is what will let Milestone 2 (Node + PostgreSQL + Render,
see the [README roadmap](../README.md#node-postgresql-and-render-roadmap-milestone-2))
reuse these two packages unchanged behind a different set of adapters — only
`packages/adapters-*` and `apps/*` are runtime-specific.

## Request lifecycle

### Iframe bootstrap

1. The dashboard loads `apps/extension-ui` in an iframe and the bridge
   handshake (`createBridge`) exchanges a short-lived session token scoped
   to one installation, workspace, application, environment, and role.
2. The UI calls `GET /api/installation` with `Authorization: Bearer <token>`.
   The Worker verifies the token (`ExtensionIdentityVerifier`, RS256 against
   the Throttle JWKS) before touching any store.
3. On first run the publisher's own operator supplies the Throttle API key
   and webhook signing secret through the UI (`PUT
/api/installation/secrets`), which are encrypted and stored, and the
   installation transitions to `active`.
4. The operator supplies provider credentials (`PUT
/api/connector/credentials`); `connectProvider`
   (`packages/core/src/connect-provider.ts`) validates them against the
   connector before persisting the encrypted credential and recording a
   `connector_sync`/`PROVIDER_CONNECTED` activity.

### Webhook → queue → provider

1. Throttle POSTs a signed event to `/webhooks/throttle`
   (`apps/cloudflare/src/routes/webhooks.ts`). The raw body is read once,
   bounded in size, and used verbatim for signature verification — it is
   never JSON-parsed first.
2. `verifyThrottleWebhook` (`packages/throttle/src/webhooks.ts`) checks the
   `X-Throttle-Signature` header (one `t`, 1–8 `v1` HMAC-SHA256 digests, 5
   minute tolerance, constant-time comparison) against every installation
   sharing the event's `(workspaceId, environmentId)` scope, so signing-key
   rotation can succeed against either the old or new secret.
3. On a verified event, the Worker calls `acceptJob`
   (`adapters.webhookAcceptance.accept`), which records the delivery
   idempotently keyed on `(installationId, event.id)` before enqueuing —
   redelivered webhooks return `202` without double-enqueuing.
4. The queue consumer (`consumeConnectorQueue`) claims the job
   (`executions.claim`, leased with a token so two concurrent deliveries of
   the same message can't double-process it), calls
   `processConnectorEvent`, and translates the result into Cloudflare Queue
   `ack()` (success/terminal) or `retry({ delaySeconds })` (retryable),
   independent of Cloudflare's own delivery-attempt counter.

See [testing.md](testing.md) for the exact failure/lifecycle scenarios this
path is tested against, and [operations.md](operations.md) for what happens
during incident response, key rotation, and uninstall.

## Data model

D1 (`packages/adapters-d1/migrations/`) holds:

- `installations` — one row per Throttle installation, scoped by
  `(workspace_id, application_id, environment_id)`, with a `status` state
  machine (`pending` → `active` → `disconnected`/`uninstalled`).
- `secrets` — encrypted envelopes (`algorithm`, `key_version`, `iv`,
  `ciphertext`) per `(installation_id, kind)` for the three secret kinds:
  `throttleApiKey`, `webhookSigningSecret`, `providerCredentials`. Triggers
  block inserting or updating a secret for an uninstalled installation.
- `deliveries` — webhook idempotency ledger, `(installation_id, event_id)`.
- `configurations` — one JSON blob per installation (bounded to 32 KB),
  validated by `packages/contracts`' `validateConfigurationValue`.
- `jobs` — durable queue-job state (`pending`/`retry`/`processing`/
  `completed`/`failed`/`cancelled`), attempt count, and lease fields used to
  make queue processing safe under concurrent/duplicate delivery.
- `activities` — an append-only audit trail (`event_received`,
  `connector_sync`) surfaced to the iframe at `GET /api/activity`.

All installation-scoped tables cascade-delete on `installations` deletion,
and triggers plus `markUninstalled`'s single atomic D1 batch enforce that an
uninstalled installation has no live secrets, configuration, or queued jobs
(see [operations.md](operations.md#uninstall--data-deletion)).
