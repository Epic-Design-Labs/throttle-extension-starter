# throttle-extension-starter

A production-shaped starter for building a [Throttle](https://usethrottle.dev)
**extension**: an embedded dashboard UI plus a backend that receives
Throttle events and talks to a third-party provider on the customer's
behalf. It is meant to be copied into your own repository and customized,
not depended on as a library — see
[One repository per provider integration](#one-repository-per-provider-integration).

This document is the onboarding index for both human developers and coding
agents. It links every deeper guide at the point you need it; you shouldn't
need to go spelunking through `docs/` unaided.

## What is a Throttle extension, and which shape is this?

Throttle extensions can be built in a few shapes — **embedded** (an iframe
UI only, no backend of your own), **backend-only** (no UI, a webhook/API
integration only), or **hybrid** (both). This starter implements the
**hybrid** shape: an embedded React UI (`apps/extension-ui`) for
installation/configuration/activity screens, backed by a Cloudflare Worker
(`apps/cloudflare`) that verifies Throttle webhooks, talks to your
third-party provider, and stores per-installation state. See
[Throttle's Extension overview](https://docs.usethrottle.dev/developers/extensions/overview)
and [Get Started guide](https://docs.usethrottle.dev/developers/extensions/get-started)
for the platform's own description of each shape and how to choose; see
also [Throttle's starter-repository guide](https://docs.usethrottle.dev/developers/extensions/starter-repository)
for how this starter fits into that picture, and the
[Build guide](https://docs.usethrottle.dev/developers/extensions/build) for
the general extension build process.

## What this starter provides vs. what you own

**The starter provides:**

- A working end-to-end reference implementation: iframe bootstrap,
  Throttle webhook receipt and verification, durable queued job processing
  against a provider, and uninstall cleanup — all covered by tests (see
  [docs/testing.md](docs/testing.md)).
- The security-sensitive plumbing already implemented correctly: raw-body
  webhook signature verification, identity JWT verification, AES-256-GCM
  credential encryption, and tenant isolation (see
  [Configuration and secrets](#configuration-and-secrets) and
  [Best practices this starter enforces](#best-practices-this-starter-enforces)).
- A **fictional, deterministic demo provider**
  (`examples/demo-connector/src/demo-provider.ts`) that exists purely so the
  reference tests have something concrete to exercise. It has no real
  external side effects: a credential is "valid" only if it is exactly the
  bytes `demo-valid`, and its behavior for a given event is driven entirely
  by a `configuration.mode` value (`'429'`, `'500'`, `'timeout'`,
  `'expired'`, `'malformed'`, `'pagination'`) so tests can exercise every
  retry/failure path on demand. See
  [docs/adding-a-provider.md](docs/adding-a-provider.md) for the full
  behavior and how to replace it.

**You own:**

- Registering your extension with Throttle and choosing its scopes/events.
- Replacing the demo provider with a real integration against your
  third-party API.
- Provisioning and configuring your own Cloudflare account resources (D1
  database, Queues, Worker name, secrets).
- Deciding your data retention, incident response, and deprecation
  procedures (see [docs/operations.md](docs/operations.md)) — the starter
  gives you the mechanism (atomic uninstall cleanup, key rotation support)
  but not the policy.
- Pulling forward any future security fixes to this template deliberately
  (see [One repository per provider integration](#one-repository-per-provider-integration)).

## Prerequisites

- **Node.js `>=20`** — see `.nvmrc` (`nvm use` picks this up automatically).
- **pnpm `10.34.5`**, pinned via the root `package.json` `packageManager`
  field. Use exactly this version (e.g. via `corepack enable`) so the
  lockfile stays reproducible; CI installs this exact version too.
- A [Throttle](https://usethrottle.dev) account with access to the
  [dashboard](https://app.usethrottle.dev) to register a Test-mode
  extension.
- A Cloudflare account (for deploying past the mocked quickstart below) and
  the `wrangler` CLI, already included as a dev dependency of
  `apps/cloudflare`.
- Optionally, [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  (invoked via `pnpm dlx`, no separate install needed) to tunnel your local
  UI to a public HTTPS URL for real iframe testing.

## Repository map

This is a single pnpm workspace (`pnpm-workspace.yaml`: `apps/*`,
`packages/*`, `examples/*`).

| Path                                           | Package                              | What it is                                                                                                                              |
| ---------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cloudflare`                              | `@starter/cloudflare`                | The Worker: Hono HTTP app + Cloudflare Queue consumer. Deployed with Wrangler.                                                          |
| `apps/extension-ui`                            | `@starter/extension-ui`              | The embedded React iframe UI (Vite).                                                                                                    |
| `packages/contracts`                           | `@starter/contracts`                 | Shared `zod` `.strict()` schemas/types — the camelCase wire contract. No runtime imports.                                               |
| `packages/core`                                | `@starter/core`                      | Runtime-agnostic business logic and ports (`connectProvider`, `processConnectorEvent`, retry policy, typed errors). No runtime imports. |
| `packages/security`                            | `@starter/security`                  | AES-256-GCM credential encryption and log redaction (Web Crypto only).                                                                  |
| `packages/throttle`                            | `@starter/throttle`                  | Webhook signature verification and identity JWT verification.                                                                           |
| `packages/adapters-d1`                         | `@starter/adapters-d1`               | `core` ports implemented against Cloudflare D1.                                                                                         |
| `packages/adapters-cloudflare-queue`           | `@starter/adapters-cloudflare-queue` | Cloudflare Queue producer/consumer.                                                                                                     |
| `examples/demo-connector`                      | `@starter/demo-connector`            | The fictional demo provider — replace this.                                                                                             |
| `tests/e2e`, `tests/helpers`, `tests/fixtures` | —                                    | The reference lifecycle test and its Miniflare-backed test harness.                                                                     |
| `docs/`                                        | —                                    | Deep-dive guides linked throughout this README.                                                                                         |
| `scripts/setup.mjs`                            | —                                    | The `pnpm setup` template-customization command.                                                                                        |

See [docs/architecture.md](docs/architecture.md) for how these pieces
connect and why the dependency boundary between `packages/contracts` /
`packages/core` and everything else is enforced.

## Quickstart (five minutes, mocked)

This gets the embedded UI running locally against a mocked bridge — no
Throttle account or Cloudflare deploy required yet.

```bash
git clone <this-repository-url>
cd throttle-extension-starter
pnpm install
```

Create `apps/extension-ui/.env.local` (git-ignored; Vite's standard local
override file, not part of the template):

```bash
VITE_USE_MOCK_BRIDGE=true
VITE_CONNECTOR_API_ORIGIN=http://localhost:8787
VITE_THROTTLE_DASHBOARD_ORIGIN=https://dashboard.usethrottle.dev
```

Then:

```bash
pnpm dev
```

`pnpm dev` runs `pnpm --parallel --filter @starter/cloudflare --filter
@starter/extension-ui dev`; today only `@starter/extension-ui` defines a
`dev` script, so this starts the UI's Vite dev server at
**http://localhost:5173**. With `VITE_USE_MOCK_BRIDGE=true`, the UI renders
against a fake bridge session (fake user/workspace/installation, a fixed
local token) so you can see and iterate on the screens in an ordinary
browser tab without an iframe, a Throttle session, or a running backend for
every screen.

To exercise the real backend logic (webhook verification, queue processing,
provider calls) locally, run the automated Miniflare-backed lifecycle test
instead of a manual server:

```bash
pnpm test -- tests/e2e/demo-extension.test.ts
```

For running the actual Worker locally with `wrangler dev` and local D1
migrations, see [docs/local-development.md](docs/local-development.md).

## Register in Test mode (real Throttle install)

Once you want to see the real iframe handshake and deliver a real Throttle
event, register the starter in Throttle **Test mode** — this is the
supported way to iterate before publishing, and does not require your
extension to be publicly reachable by anyone but you:

1. **Expose your local UI over HTTPS.** With `pnpm dev` running:

   ```bash
   pnpm dlx cloudflared tunnel --url http://localhost:5173
   ```

   Use the printed `https://*.trycloudflare.com` URL as your extension's UI
   origin.

2. **Register the extension** in the
   [Throttle dashboard](https://app.usethrottle.dev) as a Test-mode
   extension, following
   [Throttle's Get Started guide](https://docs.usethrottle.dev/developers/extensions/get-started).
   This gives you an extension ID (set `THROTTLE_EXTENSION_ID` — see
   [Configuration and secrets](#configuration-and-secrets)) and lets you
   declare the [events](https://docs.usethrottle.dev/developers/extensions/events)
   and [scopes](https://docs.usethrottle.dev/developers/extensions/scopes)
   your extension needs.
3. **Publish a Test-mode version** of the extension pointing at your tunnel
   UI URL and your deployed (or tunneled) Worker backend URL, per
   [Throttle's Versioning guide](https://docs.usethrottle.dev/developers/extensions/versioning)
   and, once you're ready to move beyond Test mode,
   [Throttle's Publishing guide](https://docs.usethrottle.dev/developers/extensions/publishing).
4. **Install it** into a Test-mode workspace/environment — see
   [Throttle's Installing guide](https://docs.usethrottle.dev/developers/extensions/install).
   This is what actually loads your UI in a real iframe and issues a real
   identity JWT.
5. **Verify the iframe loads** and completes the bridge handshake (the UI
   should move out of its loading state and show the bootstrap screen), then
   walk through bootstrap → connect → configure using your real backend.
6. **Send a test event.** Use Throttle's test-event delivery (see
   [Throttle's Testing guide](https://docs.usethrottle.dev/developers/extensions/testing))
   to deliver a real signed webhook and confirm it's accepted (`202`) and
   shows up via `GET /api/activity` once processed.
7. **Uninstall it** when you're done iterating, and confirm (via
   `GET /api/installation` returning `409`/`uninstalled`, or by inspecting
   your D1 database) that secrets and queued jobs were cleaned up — see
   [docs/operations.md](docs/operations.md#uninstall--data-deletion).

## Configuration and secrets

| Name                                                                                  | Where it lives                                                           | Classification                       | Notes                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `THROTTLE_DASHBOARD_ORIGIN`                                                           | `.env.example` (local tooling) + `wrangler.jsonc` var                    | Public                               | Exact HTTPS origin of the Throttle dashboard; used for CORS/CSP `frame-ancestors` and enforced as an exact-origin match.                                                                  |
| `THROTTLE_JWKS_URL`                                                                   | `.env.example` + `wrangler.jsonc` var                                    | Public                               | HTTPS URL of Throttle's extension JWKS, used to verify identity JWTs (RS256).                                                                                                             |
| `THROTTLE_EXTENSION_ID`                                                               | `wrangler.jsonc` var                                                     | Public, but unique to your extension | Assigned when you register in Throttle; used as the JWT audience. The Worker refuses to boot if this still looks like a placeholder.                                                      |
| `THROTTLE_READ_SCOPE` / `THROTTLE_MUTATION_SCOPE`                                     | `wrangler.jsonc` var                                                     | Public                               | The scope strings your extension declares and Throttle grants.                                                                                                                            |
| `ENCRYPTION_KEY_VERSION`                                                              | `wrangler.jsonc` var                                                     | Public                               | Integer identifying which key in the keyring is "current."                                                                                                                                |
| `QUEUE_MAX_ATTEMPTS`                                                                  | `wrangler.jsonc` var                                                     | Public                               | Durable business-retry cap (independent of Cloudflare's own queue delivery attempts).                                                                                                     |
| `ENCRYPTION_KEY`                                                                      | `apps/cloudflare/.dev.vars` (local) / Worker secret (deployed)           | **Platform secret**                  | 32-byte base64url AES-256-GCM root key. Never commit a real value — `.dev.vars` is git-ignored; use `wrangler secret put` in production.                                                  |
| `ENCRYPTION_KEYRING`                                                                  | same                                                                     | **Platform secret**                  | JSON map of prior key versions → keys, used during [key rotation](docs/operations.md#key-rotation).                                                                                       |
| `THROTTLE_BASE_URL`                                                                   | `.env.example` (local tooling)                                           | Public / reserved                    | Not currently read by any script in this repository; reserved for local tooling that talks to the Throttle API directly.                                                                  |
| `LOCAL_ENCRYPTION_KEY`                                                                | `.env.example` (local tooling)                                           | Local-only / reserved                | Not currently read by any script in this repository. Do not confuse with the Worker's own `ENCRYPTION_KEY` secret above.                                                                  |
| `throttleApiKey`, `webhookSigningSecret`, `providerCredentials`                       | Supplied through the iframe UI, stored encrypted in D1's `secrets` table | **Per installation secret**          | Encrypted at rest (AES-256-GCM, with the installation ID baked into the additional authenticated data so a ciphertext can't be moved to another installation); never logged in plaintext. |
| `VITE_USE_MOCK_BRIDGE`, `VITE_CONNECTOR_API_ORIGIN`, `VITE_THROTTLE_DASHBOARD_ORIGIN` | `apps/extension-ui/.env.local`                                           | **Browser-safe**                     | Vite inlines these into the client bundle at build time — never put an actual secret in a `VITE_` variable.                                                                               |

Copy `.env.example` to `.env` and `apps/cloudflare/.dev.vars.example` to
`apps/cloudflare/.dev.vars` to get started locally; both `.example` files
intentionally contain only empty or placeholder values. See
[docs/local-development.md](docs/local-development.md) for the full local
setup and [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md) for
production secret configuration.

## Customizing the template

```bash
pnpm setup -- --name "Your Connector Name" --slug your-connector-slug --remove-demo
```

This renames the package, README title, UI page title, and Cloudflare
resource names (worker/database/queue) consistently, and (with
`--remove-demo`) replaces the demo provider with a minimal type-checked
skeleton and removes the demo-specific lifecycle test. Omit `--remove-demo`
(or pass `--keep-demo`) to keep the working demo around while you build your
real provider alongside it. Add `--dry-run` first to preview every planned
file change, and `--force` to re-run setup on an already-customized copy.
See [docs/adding-a-provider.md](docs/adding-a-provider.md) for what to do
next: replacing `examples/demo-connector/src/demo-provider.ts`, adding event
types and scopes, and evolving the configuration schema.

## Best practices this starter enforces

- **Least privilege.** Extension identity tokens are checked against
  declared read/mutation scopes per request
  (`THROTTLE_READ_SCOPE`/`THROTTLE_MUTATION_SCOPE`); mutation routes further
  require an `admin`/`developer` role.
- **Raw-body signature verification.** Throttle webhooks are verified with
  HMAC-SHA256 over the exact raw request body — never the re-serialized
  JSON — using constant-time comparison and a bounded (5 minute) timestamp
  tolerance, checked against every installation sharing the event's
  workspace/environment scope so signing-secret rotation doesn't cause a
  verification gap.
- **Identity verification.** The embedded UI's every API call carries an
  extension identity JWT (see
  [Throttle's Identity guide](https://docs.usethrottle.dev/developers/extensions/identity)),
  verified as RS256 against Throttle's JWKS with issuer, audience,
  algorithm, and claim-shape checks — never trusted unverified.
- **Credential encryption.** Provider credentials and the webhook signing
  secret are encrypted at rest with AES-256-GCM, bound to the installation
  ID so a stolen ciphertext can't be decrypted under a different
  installation.
- **Tenant isolation.** Every store method is scoped by
  `(workspaceId, applicationId, environmentId)` in addition to installation
  ID; cross-tenant reads/writes fail closed.
- **Idempotency.** Webhook deliveries are deduplicated by
  `(installationId, eventId)` before enqueuing, and job execution is
  deduplicated again at the queue-consumer boundary — a provider side
  effect runs at most once per event even under redelivery.
- **Retries, rate limits, and pagination.** Retryable failures back off
  exponentially up to a bounded attempt count; the demo provider models
  provider-side pagination and rate limiting so you can see the pattern to
  follow for your real integration.
- **Structured, redacted logging.** The Worker's logger redacts sensitive
  fields before writing structured JSON logs.
- **Uninstall cleanup.** Uninstalling an installation atomically deletes its
  secrets and configuration and cancels any queued/in-flight work — it
  cancels queued jobs rather than letting them run against a disconnected
  provider account.
- **Data retention and version compatibility.** See
  [docs/operations.md](docs/operations.md) (and
  [Throttle's Operations guide](https://docs.usethrottle.dev/developers/extensions/operations)
  for the platform-level operational expectations) for retention guidance
  and how contract schema changes should be coordinated across the UI and
  Worker.
- **Production readiness.** `pnpm check`'s build step runs a real Wrangler
  dry-run deploy, so a broken binding or config fails before you ever
  publish.

Full depth: [docs/architecture.md](docs/architecture.md) and
[AGENTS.md](AGENTS.md) (which states these as hard invariants, not just
guidance).

## Required checks

```bash
pnpm check
```

Runs, in order: `format:check`, `lint`, `typecheck`, `test` (every
package's own suite, then the root end-to-end / workspace-boundary /
documentation tests), and `build` (every package's build, including the
Cloudflare Worker's dry-run deploy). This is the one command that must pass
before you consider a change complete — it's also exactly what CI
(`.github/workflows/ci.yml`) runs.

Individually:

```bash
pnpm format        # apply Prettier formatting
pnpm format:check  # check formatting without writing
pnpm lint          # eslint .
pnpm typecheck     # every package's typecheck, plus the root test tsconfig
pnpm test          # test:packages, then the root suite
pnpm build         # pnpm -r build
```

See [docs/testing.md](docs/testing.md) for the full test-layer breakdown and
the required failure/lifecycle matrix a new provider integration should
cover.

Before publishing a real deployment, also run:

```bash
pnpm verify:release
```

This checks for missing release artifacts, tracked secrets, placeholder
Cloudflare identifiers, and unresolved documentation markers. It's expected
to pass (with warnings about publisher-supplied values you still need to
fill in) even on a fresh copy of this template — see
[docs/release-checklist.md](docs/release-checklist.md) for the full
pre-publish checklist, including the manual production smoke test.

## Cloudflare deployment

This starter currently targets **Milestone 1: Cloudflare only** — one
Worker (`apps/cloudflare`), Cloudflare D1, and Cloudflare Queues. Before a
real deploy you must replace the placeholder identifiers in
`apps/cloudflare/wrangler.jsonc` (Worker name, D1 database name/ID, queue
names — the Worker deliberately refuses to boot if `THROTTLE_EXTENSION_ID`
still looks like a placeholder), apply migrations, and set the
`ENCRYPTION_KEY`/`ENCRYPTION_KEYRING` Worker secrets:

```bash
pnpm --filter @starter/cloudflare exec wrangler d1 create <your-database-name>
pnpm --filter @starter/cloudflare exec wrangler queues create <your-connector-queue-name>
pnpm --filter @starter/cloudflare db:migrate:local   # local D1, for development
pnpm --filter @starter/cloudflare exec wrangler d1 migrations apply DB --remote
pnpm --filter @starter/cloudflare exec wrangler secret put ENCRYPTION_KEY
pnpm --filter @starter/cloudflare build               # wrangler deploy --dry-run — verify first
pnpm --filter @starter/cloudflare exec wrangler deploy
pnpm verify:release                                   # before considering the deploy production-ready
```

Full walkthrough, including secret generation and what every `wrangler.jsonc`
var means: [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md).
Before treating a deployment as production-ready, work through
[docs/release-checklist.md](docs/release-checklist.md).

## Node, PostgreSQL, and Render roadmap (Milestone 2)

A second runtime target — a Node process backed by PostgreSQL, deployable
to Render — is **planned but not implemented in this repository yet**.
Because `packages/contracts` and `packages/core` have no runtime imports
(enforced by `tests/workspace-boundaries.test.ts`), that future milestone is
expected to add new adapter and app packages implementing the same ports
this Cloudflare Worker uses today, without changing those two portable
packages. Don't build against an `apps/node` or `packages/adapters-postgres`
path — neither exists yet.

## Testing

```bash
pnpm test
```

See [docs/testing.md](docs/testing.md) for the full breakdown: per-package
unit tests, the shared persistence-adapter contract test, the
Miniflare-backed end-to-end lifecycle test (`tests/e2e/demo-extension.test.ts`),
the workspace-boundary test, and this documentation contract test itself.
External link liveness checking is an explicit, separate opt-in command,
not part of `pnpm test`/`pnpm check`.

## Troubleshooting

- **Iframe never leaves its loading state / bridge handshake fails.**
  Confirm `VITE_THROTTLE_DASHBOARD_ORIGIN` exactly matches the dashboard
  origin Throttle is loading you from (an exact-origin mismatch is rejected,
  not just a hostname match), and that you're testing through a real
  Throttle install (Test mode) rather than a plain browser tab if
  `VITE_USE_MOCK_BRIDGE` is unset.
- **`401 WEBHOOK_VERIFICATION_FAILED`.** The raw request body, the
  `X-Throttle-Signature` header, or the webhook signing secret don't agree.
  Check you bootstrapped the installation's webhook signing secret via `PUT
/api/installation/secrets`, and that nothing in front of your Worker
  (a proxy, a tunnel) is re-encoding or otherwise altering the request body
  before it reaches the raw-body reader.
- **`403 ACCESS_DENIED` / `FORBIDDEN`.** The identity JWT's scopes don't
  include the required read/mutation scope for that route, or its
  installation/workspace/application/environment doesn't match the resource
  you're requesting — this fails closed by design (tenant isolation).
- **D1 migration errors.** Make sure you ran
  `pnpm --filter @starter/cloudflare db:migrate:local` (local) or `wrangler
d1 migrations apply DB --remote` (production) against the right database,
  and that you never hand-edited an already-applied migration file (see
  [AGENTS.md](AGENTS.md#migration-ownership)).
- **Queued jobs never process, or process forever.** Confirm your Cloudflare
  Queue consumer is actually deployed and bound (`CONNECTOR_QUEUE` in
  `wrangler.jsonc`), check `GET /api/activity` for `RETRYABLE_PROVIDER_ERROR`
  / `TERMINAL_PROVIDER_ERROR` codes, and see
  [docs/operations.md](docs/operations.md) for the retry/backoff schedule.
- **Credential or environment mismatches after a fresh deploy.** The Worker
  refuses to boot with a placeholder `THROTTLE_EXTENSION_ID`, a malformed
  `ENCRYPTION_KEY`/`ENCRYPTION_KEYRING`, or an `ENCRYPTION_KEY_VERSION` that
  collides with a keyring entry — re-check
  [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md) and
  [docs/operations.md](docs/operations.md#key-rotation).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development loop, workspace
dependency-boundary rules, and commit/PR expectations.

## Support

For questions or issues with this starter template, open an issue in this
repository. For questions about the Throttle platform itself, see the
canonical docs linked throughout this README, the
[API reference](https://docs.usethrottle.dev/developers/api-reference), the
[public packages reference](https://docs.usethrottle.dev/developers/packages),
or email `support@usethrottle.dev`. For platform status, see the Throttle
dashboard rather than a separate status page.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability, and
[Throttle's Security guide](https://docs.usethrottle.dev/developers/extensions/security)
for platform-level extension security guidance.

## License

[MIT](LICENSE) © Epic Design Labs. This is a template: your own extension's
license is your choice — update `LICENSE` if you don't want to keep MIT for
your downstream repository.

## One repository per provider integration

This starter is meant to be **copied into its own repository per provider
integration**, not depended on as a shared runtime package. That means a
security fix landing in this upstream template does not automatically reach
your downstream copy — pull fixes forward deliberately (see
[SECURITY.md](SECURITY.md#ownership-model)). This also keeps each
integration's Cloudflare resources, secrets, and release cadence
independent of every other integration built from this same starter.

## For coding agents

If you're a coding agent working in this repository (or a downstream copy
of it), read [AGENTS.md](AGENTS.md) first. In short:

- **Source of truth**: this README, then `AGENTS.md`, then
  [docs/architecture.md](docs/architecture.md), then the other `docs/*.md`
  guides.
- **Architectural invariants you must not weaken**: the
  `packages/contracts`/`packages/core` no-runtime-import boundary, raw-body
  webhook verification, RS256 identity JWT verification, AES-256-GCM
  credential encryption, camelCase `.strict()` contracts, idempotent
  webhook/job handling, and atomic uninstall cleanup — all detailed in
  [AGENTS.md](AGENTS.md#architectural-invariants--do-not-weaken-these).
- **Run before considering any task complete**: `pnpm check`.
- **Generated files you must never hand-edit**: anything under `dist/`,
  `apps/cloudflare/.wrangler/`, local `.env`/`.dev.vars` files, and
  `pnpm-lock.yaml` (change it only via `pnpm install`).
- **This repository practices test-driven development**: write or update a
  failing test before writing the implementation that makes it pass (see
  [docs/testing.md](docs/testing.md)).
