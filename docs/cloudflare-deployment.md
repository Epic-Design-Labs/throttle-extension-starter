# Cloudflare deployment

This starter targets **Milestone 1: Cloudflare only** — a single Worker
(`apps/cloudflare`) backed by D1 and Cloudflare Queues. There is no separate
staging/production Wrangler environment configuration in the checked-in
template; treat each deployment as one Cloudflare account/Worker per
environment you want (e.g. a second Worker name, D1 database, and queue pair
for a staging environment) until you introduce Wrangler environments
yourself.

## 1. Replace the placeholder resource identifiers

`apps/cloudflare/wrangler.jsonc` ships with placeholder names that must be
replaced before it can deploy for real:

```jsonc
{
  "name": "replace-with-throttle-extension-worker-name",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "replace-with-d1-database-name",
      "database_id": "00000000-0000-0000-0000-000000000000",
    },
  ],
  "queues": {
    "producers": [
      { "binding": "CONNECTOR_QUEUE", "queue": "replace-with-connector-queue" },
    ],
    "consumers": [
      {
        "queue": "replace-with-connector-queue",
        "max_retries": 4,
        "dead_letter_queue": "replace-with-connector-dead-letter-queue",
      },
    ],
  },
}
```

Create the real resources first, then paste their identifiers in:

```bash
pnpm --filter @starter/cloudflare exec wrangler d1 create <your-database-name>
pnpm --filter @starter/cloudflare exec wrangler queues create <your-connector-queue-name>
pnpm --filter @starter/cloudflare exec wrangler queues create <your-connector-dead-letter-queue-name>
```

`wrangler d1 create` prints a `database_id` — put that, and the Worker
`name` you want, and your queue names into `wrangler.jsonc`.
`THROTTLE_EXTENSION_ID` also has a placeholder default
(`replace-with-extension-id`); the Worker's environment validation
(`apps/cloudflare/src/env.ts`) deliberately **refuses to boot** if this
value still contains `replace`, `placeholder`, or `change-me`
(case-insensitive), so deploying with an unset extension ID fails fast
instead of silently misrouting identity verification.

## 2. Apply migrations to the remote database

```bash
pnpm --filter @starter/cloudflare exec wrangler d1 migrations apply DB --remote
```

(`db:migrate:local` in `package.json` runs the equivalent `--local` command
against Wrangler's local D1 simulation — see
[local-development.md](local-development.md).) Migrations in
`packages/adapters-d1/migrations/` are applied in numeric order and are
append-only; never edit an already-applied migration (see
[AGENTS.md](../AGENTS.md#migration-ownership)).

## 3. Configure secrets

`ENCRYPTION_KEY` and `ENCRYPTION_KEYRING` are Cloudflare Worker **secrets**,
not plaintext `vars` — they never belong in `wrangler.jsonc`:

```bash
pnpm --filter @starter/cloudflare exec wrangler secret put ENCRYPTION_KEY
pnpm --filter @starter/cloudflare exec wrangler secret put ENCRYPTION_KEYRING
```

- `ENCRYPTION_KEY` must be a distinct 32-byte key, base64url-encoded (see
  `apps/cloudflare/.dev.vars.example` for the local equivalent format).
  Generate one with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  ```

- `ENCRYPTION_KEYRING` is a JSON object mapping prior numeric key versions
  to their base64url keys, `{}` until you rotate. See
  [operations.md](operations.md#key-rotation) for the rotation procedure —
  `ENCRYPTION_KEY_VERSION` (a plain `var`) must always point at the key
  currently in `ENCRYPTION_KEY`, and the keyring holds the _previous_
  version(s) so already-encrypted secrets keep decrypting during and after a
  rotation.

## 4. Configure the remaining vars

The rest of `wrangler.jsonc`'s `vars` block matters for a real deployment:

- `THROTTLE_DASHBOARD_ORIGIN` / `THROTTLE_JWKS_URL` — normally left at the
  Throttle-hosted defaults shown in the template unless Throttle instructs
  you otherwise.
- `THROTTLE_EXTENSION_ID` — the extension ID assigned when you register the
  extension in the Throttle dashboard (see the root
  [README's Test-mode walkthrough](../README.md#register-in-test-mode-real-throttle-install)).
- `EXTENSION_UI_ORIGIN` — the exact HTTPS origin your extension UI is
  deployed on (e.g. a Cloudflare Pages URL). The iframe UI calls this Worker
  cross-origin, so the Worker's CORS allowlist must include it — without it,
  every UI request fails preflight. Leave it unset only if this Worker serves
  the UI itself (same origin).
- `THROTTLE_READ_SCOPE` / `THROTTLE_MUTATION_SCOPE` — the scope strings your
  extension declares and Throttle grants; see
  [Throttle's Scopes guide](https://docs.usethrottle.dev/developers/extensions/scopes).
- `QUEUE_MAX_ATTEMPTS` — the durable business-retry cap enforced by
  `packages/core`'s retry policy (defaults to `5`; see
  [architecture.md](architecture.md#webhook--queue--provider)). This is
  independent of the Cloudflare Queue consumer's own `max_retries`
  (currently `4` in `wrangler.jsonc`), which governs Cloudflare-level
  message redelivery before the dead-letter queue, not business attempts.

## 5. Verify before deploying

```bash
pnpm --filter @starter/cloudflare build
```

This runs `wrangler deploy --dry-run --outdir dist` — it validates your
`wrangler.jsonc` bindings and compiles the Worker without publishing
anything. It's also part of `pnpm check`, so a broken configuration fails
CI before it ever reaches a real deploy.

## 6. Deploy

```bash
pnpm --filter @starter/cloudflare exec wrangler deploy
```

After deploying, point your Throttle extension's registered backend/UI
URLs at the deployed Worker and hosted UI, and move the installation out of
Test mode per
[Throttle's Publishing guide](https://docs.usethrottle.dev/developers/extensions/publishing)
when you're ready.

## 7. Verify release readiness

Before considering any deployment production ready, run:

```bash
pnpm verify:release
```

This checks for missing release artifacts, tracked secrets, placeholder
Cloudflare identifiers left over from this template, and unresolved
documentation markers. It passes (exit code 0) even on an unconfigured
copy of this template, but warns until you've replaced the placeholder
identifiers described in step 1 above. Then work through the full
publisher checklist in [docs/release-checklist.md](release-checklist.md) —
clean install/uninstall, least-privilege scopes, HTTPS, health checks,
a manual production smoke test, rollback, data deletion, and credential
rotation — before announcing the extension is live.

## Roadmap: Node/PostgreSQL with Render (Milestone 2)

A second runtime target — a Node process backed by PostgreSQL, deployable
to Render — is planned but **not implemented yet**. Because
`packages/contracts` and `packages/core` have no runtime imports (see
[architecture.md](architecture.md)), that future work is expected to add
new `apps/node` and `packages/adapters-postgres` packages implementing the
same `core` ports, without changing the portable packages. Nothing in this
milestone exists in the repository today — don't build against an
`apps/node` or `packages/adapters-postgres` path that hasn't landed.
