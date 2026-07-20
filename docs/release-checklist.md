# Release checklist

This checklist is for the **publisher** of an extension built from this
starter — the person or team about to make a Cloudflare deployment
available to real Throttle installations for the first time (or to publish
an update after the first release). It is a human checklist, not a script:
run [`pnpm verify:release`](../README.md#required-checks) first to catch
the mechanical parts (missing files, tracked secrets, unresolved
documentation markers, placeholder Cloudflare identifiers), then work
through the items below, which require judgment or access this repository
cannot verify for you.

Nothing in this file has been performed on your behalf. Every item is
something you, the publisher, do against your own Cloudflare account and
Throttle installation.

## Before your first production deploy

- [ ] **Clean install/uninstall verified in Test mode.** Install the
      extension into a Test-mode Throttle installation from a clean state,
      exercise its normal event flow, then uninstall it and confirm queued
      and in-flight work is cancelled and secrets are deleted (see
      [operations.md's uninstall / data deletion
      section](operations.md#uninstall--data-deletion)). Repeat the
      install/uninstall/reinstall cycle at least once to catch state left
      behind by an incomplete cleanup.
- [ ] **Least-privilege scopes requested.** Confirm the extension only
      requests the Throttle scopes it actually uses (see
      [Throttle's Scopes guide](https://docs.usethrottle.dev/developers/extensions/scopes))
      and that `THROTTLE_READ_SCOPE` / `THROTTLE_MUTATION_SCOPE` in
      `apps/cloudflare/wrangler.jsonc` match what you registered in the
      Throttle dashboard.
- [ ] **Webhook replay safety confirmed.** Replay a previously-delivered
      webhook (same signature, same body) against the deployed Worker and
      confirm it is rejected or safely deduplicated rather than reprocessed
      (see the idempotency and signature-verification behavior described in
      the root [README](../README.md#best-practices-this-starter-enforces)).
- [ ] **HTTPS enforced end-to-end.** Confirm the deployed Worker URL, the
      hosted extension UI, and every registered callback/webhook URL in the
      Throttle dashboard use `https://` — Cloudflare Workers serve HTTPS by
      default, but double-check any custom domain or route configuration.
- [ ] **Health checks reachable.** Confirm `GET /health/live` and
      `GET /health/ready` both return `200` against the deployed Worker
      (`https://<your-worker>/health/live`,
      `https://<your-worker>/health/ready`) before pointing real traffic at
      it.
- [ ] **Marketplace screenshots contain no real customer data.** Every
      screenshot or recording submitted with the extension listing uses
      demo/synthetic data — no real installation names, account
      identifiers, tokens, or customer-provided content.
- [ ] **Privacy, terms, and support URLs published.** The extension listing
      links a real, reachable privacy policy, terms of service, and support
      contact (this starter's own support address is
      `support@usethrottle.dev`; replace it with your own before
      publishing — see [SECURITY.md](../SECURITY.md)).
- [ ] **Production smoke test performed manually.** After deploying for
      real (`pnpm --filter @starter/cloudflare exec wrangler deploy`, per
      [cloudflare-deployment.md](cloudflare-deployment.md)), manually
      install the extension into a real (or dedicated staging) Throttle
      Test-mode installation and confirm: install succeeds, a real webhook
      event is received and processed, the embedded UI loads inside the
      Throttle dashboard iframe, and uninstall cleans up correctly. This is
      a manual step you perform against your own Cloudflare account and
      Throttle installation — it is intentionally not automated by this
      repository or by any coding agent, since it requires real
      credentials and a real Throttle install this repository does not
      have.
- [ ] **Rollback plan documented.** Know, in advance, how you will roll
      back a bad deploy — at minimum, `wrangler deployments list` /
      `wrangler rollback` for the Worker, and how you would restore D1 if a
      migration needs reverting (migrations in this starter are append-only
      forward migrations; see
      [AGENTS.md](../AGENTS.md#migration-ownership) — a rollback is a new
      forward migration, not an edit to an old one).
- [ ] **Data deletion procedure documented.** Confirm you can honor a
      request to delete an installation's data end-to-end; see
      [operations.md's uninstall / data deletion
      section](operations.md#uninstall--data-deletion) for what this
      starter deletes automatically on uninstall versus what you must
      additionally handle (e.g. provider-side data your extension wrote).
- [ ] **Credential rotation procedure documented and tested.** Confirm you
      know how to rotate `ENCRYPTION_KEY` (and populate
      `ENCRYPTION_KEYRING` with the previous version) without breaking
      already-encrypted installation credentials, and how to rotate the
      Throttle webhook signing secret; see
      [operations.md's key rotation section](operations.md#key-rotation).
- [ ] **Operational owner assigned.** A named person or team is
      responsible for this deployment: who gets paged if the Worker is
      down, who rotates credentials on schedule, and who is the point of
      contact for the `support@usethrottle.dev`-equivalent address you
      publish for this extension.

## Automated gate

Run before every release:

```bash
pnpm check
pnpm verify:release
```

`pnpm verify:release` is expected to **pass** (exit code 0) even on a fresh
copy of this template, but it will print **warnings** — not errors — for
things only you, the publisher, can supply:

- Placeholder Cloudflare identifiers in `apps/cloudflare/wrangler.jsonc`
  (Worker name, D1 database name/ID, queue names) until you replace them
  per [cloudflare-deployment.md](cloudflare-deployment.md).
- The placeholder `<this-repository-url>` in the README quickstart until
  you replace it with your published repository's real URL.

Warnings do not fail the command; they are a reminder of what still needs
publisher-specific values before a real deploy. If `pnpm verify:release`
reports any **errors**, treat the release as blocked until they're fixed.
