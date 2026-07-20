# Local development

This guide covers the day-to-day inner loop: running the extension UI and
the Worker locally, applying D1 migrations, and exposing the UI to Throttle
over a tunnel for real iframe testing. For the one-time clean-clone
quickstart and Test-mode registration walkthrough, see the root
[README](../README.md#quickstart-five-minutes-mocked).

## Prerequisites

- Node.js `>=20` (see `.nvmrc`; `nvm use` picks it up automatically).
- pnpm `10.34.5`, pinned via the root `package.json` `packageManager` field.
  Use Corepack (`corepack enable`) or install this exact version so the
  lockfile stays reproducible.
- `pnpm install` at the repository root (this is a single pnpm workspace —
  do not `cd` into a package and run `npm install`).

## Running the extension UI

```bash
pnpm dev
```

This runs `pnpm --parallel --filter @starter/cloudflare --filter
@starter/extension-ui dev`. Today only `@starter/extension-ui` defines a
`dev` script (Vite), so this starts the embedded UI's dev server at
**http://localhost:5173**. `@starter/cloudflare` does not define a `dev`
script — see [Running the Worker locally](#running-the-worker-locally)
below for how to exercise the backend directly.

By default the UI expects three Vite environment variables, which you
supply via `apps/extension-ui/.env.local` (Vite's standard convention —
this file is not part of the template and is git-ignored by the blanket
`.env` rule):

```bash
# apps/extension-ui/.env.local
VITE_USE_MOCK_BRIDGE=true
VITE_CONNECTOR_API_ORIGIN=http://localhost:8787
VITE_THROTTLE_DASHBOARD_ORIGIN=https://dashboard.usethrottle.dev
```

With `VITE_USE_MOCK_BRIDGE=true`, `createExtensionBridge`
(`apps/extension-ui/src/bridge.ts`) returns a local mock bridge context
(fake user/workspace/installation, a fixed `local-development-token`)
instead of performing the real `postMessage` handshake, so you can develop
the UI standalone in a normal browser tab without an iframe or a live
Throttle session. Switch it to `false` (and drop `VITE_USE_MOCK_BRIDGE`
entirely for a real deployment — the bridge factory throws if it is `true`
in a production build) once you want to test the real handshake through a
tunnel.

## Running the Worker locally

The Cloudflare Worker (`apps/cloudflare`) has no bundled `dev` script yet;
run it directly with Wrangler, which is already a dev dependency:

```bash
pnpm --filter @starter/cloudflare exec wrangler dev
```

Before that will boot, you need:

1. **Local D1 migrations.** Apply the schema to Wrangler's local D1
   simulation:

   ```bash
   pnpm --filter @starter/cloudflare db:migrate:local
   ```

   (This runs `wrangler d1 migrations apply DB --local` against the `DB`
   binding declared in `apps/cloudflare/wrangler.jsonc`.)

2. **`.dev.vars`.** Copy `apps/cloudflare/.dev.vars.example` to
   `apps/cloudflare/.dev.vars` and fill in `ENCRYPTION_KEY` (a distinct
   32-byte, base64url-encoded key — generate one with, e.g., `node -e
"console.log(require('crypto').randomBytes(32).toString('base64url'))"`)
   and `ENCRYPTION_KEYRING` (leave as `{}` unless you're testing key
   rotation locally; see [operations.md](operations.md#key-rotation)).
   `.dev.vars` is git-ignored — never commit it.
3. A root `.env` copied from `.env.example`, if you're wiring up anything
   that reads it directly (most local iteration only needs the Worker-level
   `.dev.vars` above).

With those in place, `wrangler dev` runs the same Hono app and D1/Queue
bindings the deployed Worker uses, on `http://localhost:8787` by default —
matching the `VITE_CONNECTOR_API_ORIGIN` shown above.

For automated local verification of the whole webhook → queue → provider
path (no manual `wrangler dev` needed), prefer the Miniflare-backed
end-to-end suite — see [testing.md](testing.md#end-to-end-lifecycle-test).

## Exposing the UI for real iframe testing

Throttle's dashboard needs to load your UI over HTTPS from a reachable
origin. The fastest way to get that locally is a tunnel in front of the Vite
dev server:

```bash
pnpm dlx cloudflared tunnel --url http://localhost:5173
```

Use the resulting `https://*.trycloudflare.com` URL as the extension's UI
origin when you register it in Throttle **Test mode** — see the
[README's Test-mode walkthrough](../README.md#register-in-test-mode-real-throttle-install)
for the full registration → install → iframe verification → test-event →
uninstall sequence, and
[Throttle's Install guide](https://docs.usethrottle.dev/developers/extensions/install)
for the platform-side steps.

If you also need the Worker reachable from Throttle (e.g. to receive real
webhook deliveries while iterating), run a second tunnel against
`wrangler dev`'s port and point your Test-mode extension configuration's
backend URL at that tunnel instead of `localhost`.

## Common local commands

| Command                                               | What it does                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm install`                                        | Install all workspace dependencies.                                                  |
| `pnpm setup -- --name "..." --slug ...`               | Customize the template (see [adding-a-provider.md](adding-a-provider.md)).           |
| `pnpm dev`                                            | Start the extension UI's Vite dev server.                                            |
| `pnpm --filter @starter/cloudflare exec wrangler dev` | Run the Worker locally against local D1/Queue simulations.                           |
| `pnpm --filter @starter/cloudflare db:migrate:local`  | Apply D1 migrations to the local database.                                           |
| `pnpm test`                                           | Run every package's tests, then the root e2e/workspace-boundary/documentation tests. |
| `pnpm check`                                          | The full required gate: format check, lint, typecheck, test, build.                  |

## Troubleshooting local development

See the root README's [Troubleshooting](../README.md#troubleshooting)
section for bridge handshake failures, invalid-signature errors, migration
errors, queue issues, and credential/environment mismatches.
