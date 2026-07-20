# Operations

Incident response, data deletion, key rotation, and compatibility guidance
for a deployed extension built from this starter. See
[cloudflare-deployment.md](cloudflare-deployment.md) for first-time
deployment and [architecture.md](architecture.md) for how the pieces fit
together.

## Uninstall / data deletion

When an installation is uninstalled, `markUninstalled`
(`packages/adapters-d1/src/installations.ts`) runs one atomic D1 batch that:

1. Transitions the installation to `status = 'uninstalled'` and records
   `uninstalled_at` (idempotently — calling it again is a no-op and keeps
   the original timestamp).
2. Deletes every row in `secrets` for that installation (the Throttle API
   key, webhook signing secret, and provider credentials).
3. Deletes the installation's `configurations` row.
4. Cancels every `pending`/`retry`/`processing` job for that installation
   (`status = 'cancelled'`), so nothing queued keeps running against a
   provider account that's no longer connected.

D1 triggers (`secrets_block_uninstalled_insert/update`,
`configurations_block_uninstalled_insert/update`,
`jobs_block_uninstalled_requeue`) additionally make it impossible to insert
or resurrect secrets, configuration, or active jobs for an installation once
it's uninstalled, even if application code tries to. `activities` rows are
**not** deleted on uninstall — they're an audit trail, not a secret; apply
your own retention/deletion policy to that table if your data-retention
requirements need one (see [Data retention](#data-retention) below).

This is exercised end-to-end by the `'cancels accepted work when uninstalled
before queue drain'` case in
`tests/e2e/demo-extension.test.ts` and by the shared persistence contract
test `'scoped uninstall is atomic, idempotent, and cannot mutate another
tenant'` in `packages/core/src/contract-tests.ts` (run against
`packages/adapters-d1`).

## Data retention

Beyond uninstall cleanup, this starter does not implement a time-based
retention policy for `activities` (or, before uninstall, for `deliveries`,
which is a webhook-idempotency ledger keyed by `(installation_id,
event_id)`). If your compliance requirements need bounded retention,
schedule periodic deletes against those tables directly (e.g. a Cloudflare
Cron Trigger calling a maintenance route, or a scheduled `wrangler d1
execute` against your remote database) — nothing in the request path depends
on unbounded history in either table.

## Key rotation

### Encryption key (`ENCRYPTION_KEY`)

Provider credentials and webhook signing secrets are encrypted at rest with
AES-256-GCM under a versioned root key (see
[architecture.md](architecture.md) and
`packages/security/src/encryption.ts`). To rotate:

1. Generate a new 32-byte base64url key.
2. Set `ENCRYPTION_KEYRING` (a Worker secret) to a JSON object mapping the
   **current** `ENCRYPTION_KEY_VERSION` to the **current** `ENCRYPTION_KEY`
   value, e.g. `{"1": "<old-key>"}`.
3. Set `ENCRYPTION_KEY` (a Worker secret) to the new key value.
4. Bump the `ENCRYPTION_KEY_VERSION` var in `wrangler.jsonc` (or your
   deployment tooling) to the next integer and redeploy.

After this, newly encrypted secrets use the new key/version; secrets
encrypted under the old version keep decrypting correctly because
`env.ts`'s `keyring.resolve` looks them up by the `keyVersion` stored
alongside each ciphertext. Only remove an old key from
`ENCRYPTION_KEYRING` once you're certain nothing still references that
version (see the `'reads retained old credential keys and writes with the
rotated current key'` contract test for the exact guarantee this relies
on). `ENCRYPTION_KEY_VERSION` and the current entry in `ENCRYPTION_KEYRING`
must never be the same version — `validateEnv` rejects that configuration
at boot.

### Throttle API key and webhook signing secret

These are per-installation secrets supplied through the iframe UI (`PUT
/api/installation/secrets`). To rotate them for an installation, resend that
request with `replace: true` — the bootstrap path
(`InstallationBootstrapError` / `mapBootstrapError` in
`apps/cloudflare/src/composition/index.ts`) requires that explicit
confirmation before overwriting existing secrets, returning
`ROTATION_CONFIRMATION_REQUIRED` (409) otherwise. Because webhook
verification checks every installation sharing the event's
`(workspaceId, environmentId)` scope against up to 8 `v1` signature
candidates in a single header, Throttle-side signing-secret rotation can
roll forward without a verification gap as long as Throttle sends both the
old and new signatures during its own rotation window.

## Incident response

If you suspect a credential or signing secret has been compromised:

1. **Rotate first, investigate second.** Resend `PUT
/api/installation/secrets` with `replace: true` for the affected
   installation(s) (or roll the shared `ENCRYPTION_KEY` per
   [above](#encryption-key-encryption_key) if the compromise is at the
   encryption-key level, not a single installation's secret).
2. **Check the audit trail.** `GET /api/activity` (and the underlying
   `activities` table) records every webhook acceptance and connector sync
   attempt, including error codes (`toActivityErrorCode` in
   `packages/core/src/errors.ts`) — use it to scope the blast radius.
3. **Check structured logs.** The Worker's logger
   (`apps/cloudflare/src/composition/index.ts` → `logger()`) redacts fields
   via `packages/security/src/redaction.ts` before writing structured JSON
   to `console`; review your Cloudflare Workers Logs / Logpush destination
   for the affected `requestId`s (every response includes an
   `x-request-id` header and every error log line includes the matching
   `requestId`).
4. **If an installation itself is compromised or decommissioned**, uninstall
   it (`DELETE /api/connector`, or have Throttle uninstall the extension) to
   trigger the atomic cleanup in [Uninstall / data deletion](#uninstall--data-deletion)
   above.
5. Report a vulnerability in the starter itself per [SECURITY.md](../SECURITY.md).

## Version compatibility

- The Worker checks the extension identity JWT's `version` claim is present
  or reads the installation's own persisted `extensionVersion`
  (`Installation.extensionVersion`), but does not currently branch behavior
  on it — if you need to support multiple deployed extension versions
  simultaneously with different request/response shapes, add explicit
  version handling in your routes rather than assuming the newest schema.
- `packages/contracts` schemas are `.strict()` — a UI or Worker built
  against an older contract version will reject payloads with added fields
  from a newer one, rather than silently drop them. Treat any contract
  schema change as a coordinated deploy of both `apps/cloudflare` and
  `apps/extension-ui` (they should always be deployed together from the
  same commit).
- See [Throttle's Versioning guide](https://docs.usethrottle.dev/developers/extensions/versioning)
  for how the platform expects extension version publication and rollout to
  work.

## Deprecation

When you stop maintaining an extension built from this starter:

1. Follow [Throttle's Publishing guide](https://docs.usethrottle.dev/developers/extensions/publishing)
   to unpublish or mark the extension deprecated in the dashboard so new
   installs are blocked.
2. Decide what to do with existing installations' data under your own data
   retention/legal obligations — uninstalling each installation (or having
   Throttle do so) triggers the cleanup in
   [Uninstall / data deletion](#uninstall--data-deletion); it does not, by
   itself, delete `activities` history (see [Data retention](#data-retention)).
3. Rotate and then revoke the Worker's `ENCRYPTION_KEY`/`ENCRYPTION_KEYRING`
   secrets and any provider-side API credentials once you're certain no
   installation still needs them decrypted.
4. Tear down the Cloudflare resources (`wrangler d1 delete`, `wrangler
queues delete`, `wrangler delete` for the Worker itself) only after
   confirming the above.
