# AGENTS.md

Instructions for coding agents (and a quick-reference checklist for humans)
working in this repository. This file describes the **starter template**
itself. If you are an agent working in a downstream repository that was
generated from this starter, re-derive an equivalent file for that product —
do not assume every rule below still applies verbatim once the demo provider
has been replaced.

## Source of truth

Read these before making changes, in this order:

1. [README.md](README.md) — the onboarding index: what this starter is, the
   quickstart, the secret inventory, and links to every deeper guide.
2. This file (`AGENTS.md`) — invariants and rules that apply to every change.
3. [docs/architecture.md](docs/architecture.md) — how the pieces fit
   together and why the boundaries exist.
4. The other `docs/*.md` guides for task-specific depth (local development,
   Cloudflare deployment, adding a provider, testing, operations).

Treat the actual source under `packages/`, `apps/`, and `examples/` as more
authoritative than any prose (including this file) whenever they disagree —
but if you find a real disagreement, treat it as a bug in the docs and fix
the docs (or flag it), rather than silently trusting stale prose.

## Architectural invariants — do not weaken these

These are load-bearing security and portability properties of the actual
implementation. Do not change the following without treating it as a
deliberate, reviewed security decision:

- **Dependency boundaries.** `packages/contracts/src` and `packages/core/src`
  must have **no runtime imports** — no `node:*`, `cloudflare:*`,
  `@cloudflare/*`, `react*`, `postgres*`, or `wrangler*` module specifiers,
  static or dynamic. This is what lets those two packages be reused by a
  future Node/PostgreSQL runtime unmodified. It is enforced by
  `tests/workspace-boundaries.test.ts`; do not weaken or delete that test to
  make an import "just work."
- **Raw-body webhook verification.** Webhook signatures are verified against
  the exact raw request body bytes (`packages/throttle/src/webhooks.ts`)
  using HMAC-SHA256, constant-time comparison
  (`constantTimeEqual`), and a bounded timestamp tolerance (5 minutes by
  default). Never parse the JSON body before verifying the signature, never
  replace the constant-time comparison with `===`/`includes`, and never
  widen the signature header size or candidate-count limits
  (`MAX_WEBHOOK_SIGNATURE_HEADER_BYTES`, `MAX_WEBHOOK_V1_SIGNATURES`,
  `MAX_WEBHOOK_VERIFICATION_CANDIDATES`) without a reviewed reason.
- **Identity JWT verification.** Extension identity tokens are RS256 JWTs
  verified against the Throttle JWKS
  (`packages/throttle/src/identity.ts`), with required issuer (`throttle`),
  audience (the extension ID), algorithm allow-list (`RS256` only), claim
  shape (`claimsSchema`, `.strict()`), and expiry/not-before/issued-at
  checks. Never accept an unverified token, never widen the algorithm
  allow-list, and never drop the `sub === installationId` /
  `aud === extensionId` cross-checks.
- **Credential encryption.** Provider credentials and webhook signing
  secrets are encrypted at rest with AES-256-GCM
  (`packages/security/src/encryption.ts`), with the installation ID baked
  into the AAD so a ciphertext cannot be decrypted under a different
  installation's identity. Never store provider credentials or the webhook
  signing secret in plaintext, and never remove the installation-bound AAD.
- **camelCase public contracts.** Every schema in `packages/contracts/src`
  is a `zod` `.strict()` object with camelCase field names — this is the
  wire contract between the Worker, the extension UI, and tests. Do not add
  snake_case fields to a contract schema, and do not make a contract schema
  non-strict (which would silently accept unknown fields).
- **Idempotency.** Webhook deliveries are deduplicated by
  `(installationId, event.id)` before being enqueued
  (`adapters.webhookAcceptance.accept`), and job execution is deduplicated
  again at the queue-consumer boundary (`executions.claim` /
  `connectorIdempotencyKey` in `packages/core/src/process-event.ts`). Do not
  remove either dedup layer — a provider side effect (e.g. "create order")
  must run at most once per event even when Cloudflare Queues redelivers a
  message.
- **Retries.** Retryable provider/infrastructure failures back off
  exponentially (`retryDelaySeconds`, base 5 seconds, capped at 900 seconds)
  up to `MAX_JOB_ATTEMPTS` (5) durable attempts, tracked independently of
  Cloudflare's own queue delivery-attempt counter. Do not conflate the two
  attempt counters or remove the cap.
- **Uninstall cleanup.** `markUninstalled`
  (`packages/adapters-d1/src/installations.ts`) deletes the installation's
  secrets and configuration rows and cancels any pending/retry/processing
  jobs, atomically, in the same D1 batch as the status transition. Never add
  a code path that leaves credentials or queued work behind after
  uninstall.
- **Tenant isolation.** Every installation-scoped store method takes and
  enforces `{ workspaceId, applicationId, environmentId }` alongside the
  installation ID. Do not add a lookup path that returns or mutates another
  installation's data based on installation ID alone.

## Commands to run before considering a task complete

```bash
pnpm check
```

This is the single required gate: `format:check && lint && typecheck && test
&& build`. `test` runs every package's own suite and then the root
end-to-end, workspace-boundary, and documentation tests; `build` includes a
Cloudflare Worker dry-run deploy, so a real config or binding mistake in
`apps/cloudflare/wrangler.jsonc` fails `pnpm check` too.

This repository practices test-driven development (TDD): write or update a
failing test before writing the implementation that makes it pass. See
[docs/testing.md](docs/testing.md) for the required failure/lifecycle test
matrix a new provider integration or event type must cover.

## Generated and template-managed files — do not hand-edit

- `**/dist/**` in every package and app is a build output directory
  (`pnpm build` output). It is git-ignored; never hand-edit or commit files
  under `dist/`.
- `apps/cloudflare/.wrangler/` and any local `.dev.vars`/`.env` are
  generated/local-only and git-ignored; never commit them.
- `pnpm-lock.yaml` is generated by pnpm; change it only via `pnpm install`
  and similar pnpm commands, never by hand.
- `.throttle-starter.json` (written by `scripts/setup.mjs`) records the
  customization state of a downstream copy of this template. It is not
  meaningful in the template repository itself; do not hand-author it.

## Migration ownership

D1 migrations under `packages/adapters-d1/migrations/` are append-only:
**never edit a migration file that has already been committed**, even to fix
a typo — add a new, higher-numbered migration instead. Editing a committed
migration silently breaks any environment that already applied it.

## Prohibited shortcuts

The following are never acceptable, even to make a test pass faster or a
build go green:

- Weakening, skipping, or deleting a test to work around a real failure
  instead of fixing the underlying issue (this applies especially to
  `tests/workspace-boundaries.test.ts`, `tests/e2e/demo-extension.test.ts`,
  and this file's own `tests/documentation.test.ts`).
- Logging secrets, tokens, credentials, or raw webhook signing secrets —
  use the structured, redacting logger (`packages/security/src/redaction.ts`
  via `@starter/core`'s `Logger`) and never `console.log` a payload
  directly.
- Adding a `docs:check-links` script or any other network-touching check to
  the default `pnpm test`/`pnpm check` path — external link verification
  must remain an explicit, separate, opt-in command.
- Introducing a new runtime import into `packages/contracts/src` or
  `packages/core/src`.
- Committing real secret values anywhere, including in `.env.example` or
  `.dev.vars.example` (those files must stay empty/placeholder).
