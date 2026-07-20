# Testing

This repository practices test-driven development: add or update a failing
test before writing the implementation that makes it pass. This guide
describes the test layers that exist, how to run them, and the
failure/lifecycle matrix a new provider integration or event type should
cover.

## Running tests

```bash
pnpm test
```

Runs `test:packages` (every workspace package's own Vitest suite, in
sequence: `@starter/adapters-cloudflare-queue`, `@starter/adapters-d1`,
`@starter/contracts`, `@starter/security`, `@starter/core`,
`@starter/throttle`, `@starter/demo-connector`, `@starter/cloudflare`,
`@starter/extension-ui`), then the root suite
(`vitest run --config vitest.root.config.ts`), which covers
`tests/e2e/**`, `tests/workspace-boundaries.test.ts`,
`tests/documentation.test.ts`, and `scripts/**/*.test.ts`.

To scope a run:

```bash
pnpm --filter @starter/core test        # one package's suite
pnpm test -- tests/e2e/demo-extension.test.ts   # one root-level file
```

`pnpm check` runs `pnpm test` as one step alongside formatting, linting,
typechecking, and the build (which includes a Wrangler dry-run deploy) —
see the root [README](../README.md#required-checks).

## Test layers

| Layer                        | Where                                                                                                                             | What it proves                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests                   | `packages/*/src/*.test.ts`, `apps/*/src/**/*.test.ts`                                                                             | Individual functions/modules: schema validation, encryption round-trips, signature verification edge cases, retry math, route handlers, React components.                                                                                                                                                                                                                                                                   |
| Persistence adapter contract | `packages/core/src/contract-tests.ts` (`runPersistenceAdapterContract`), exercised by `packages/adapters-d1/src/adapters.test.ts` | A reusable behavioral contract every `core` port implementation must satisfy: tenant isolation, encrypted-credential round-tripping and key rotation, exactly-once concurrent delivery acceptance, atomic and idempotent uninstall, activity ordering. Implement a new runtime adapter (see [adding-a-provider.md](adding-a-provider.md#implementing-a-new-runtime-adapter))? Run this suite against it before trusting it. |
| End-to-end lifecycle         | `tests/e2e/demo-extension.test.ts` via `tests/helpers/test-system.ts`                                                             | The full webhook → queue → provider path through the real `composeWorker` production composition, backed by Miniflare's D1 and an in-memory Cloudflare Queue stand-in, with a real RSA-signed identity JWT and real HMAC webhook signatures.                                                                                                                                                                                |
| Workspace boundaries         | `tests/workspace-boundaries.test.ts`                                                                                              | `packages/contracts/src` and `packages/core/src` have zero runtime imports; the workspace's TypeScript path aliases and no-emit/build tsconfigs stay consistent.                                                                                                                                                                                                                                                            |
| Documentation contract       | `tests/documentation.test.ts`                                                                                                     | The README's local links resolve, it references every required guide and canonical Throttle URL, its commands match real `package.json` scripts, and required security/operational topics are covered. Offline only — see [Documentation link checking](#documentation-link-checking) below.                                                                                                                                |
| Template customization       | `scripts/setup.test.ts`                                                                                                           | `pnpm setup` rewrites only the allowlisted tokens, refuses unsafe input, and produces a type-checked provider skeleton when `--remove-demo` is used.                                                                                                                                                                                                                                                                        |

## End-to-end lifecycle test

`tests/e2e/demo-extension.test.ts` is the reference test for "does the whole
system work end to end," and the pattern to copy when you add your own
provider or event type. It exercises, against a real Miniflare D1 instance
and the actual `composeWorker` used in production:

- A signed webhook is accepted once and a duplicate delivery of the same
  event is accepted (`202`) but processed exactly once.
- A crash between accepting a job and marking it enqueued is safely
  recovered without duplicating the provider side effect (the injected
  `failFirstQueuePublishMark` fault).
- An invalid webhook signature is rejected (`401`) without accepting any
  work, and the wrong signing secret never leaks into the response body.
- A JWT for a different installation is rejected at the HTTP boundary
  (`403 ACCESS_DENIED`).
- Events with out-of-order `createdAt` timestamps are processed as
  independent events.
- A retryable provider failure (`configuration.mode: '429'`) is retried with
  the documented backoff schedule and later succeeds once the provider
  recovers.
- Five consecutive retryable failures exhaust the retry budget
  (`MAX_JOB_ATTEMPTS`) and the job is marked `failed` with
  `ATTEMPTS_EXHAUSTED`, following the exact `5, 25, 125, 625` second backoff
  schedule.
- Expired/invalid provider credentials fail terminally
  (`TERMINAL_PROVIDER_ERROR`) without retrying.
- Uninstalling before a queued job drains cancels the job and prevents the
  provider side effect from ever running, and the activity API returns
  `409` once uninstalled.
- The helper (`tests/helpers/test-system.ts`) itself is asserted to use the
  real `composeWorker` production entrypoint rather than re-wiring
  lower-level pieces by hand, so this test can't drift from what actually
  ships.

When you replace the demo provider (see
[adding-a-provider.md](adding-a-provider.md)), either adapt this test file to
your provider's real behavior and failure modes, or delete it via `pnpm
setup -- --remove-demo` and write an equivalent lifecycle test against your
own provider, covering at minimum: duplicate delivery, invalid signature,
cross-installation access, retryable failure + recovery, retry exhaustion,
terminal provider failure, and uninstall-cancels-queued-work.

## Documentation link checking

`tests/documentation.test.ts` never makes network requests — it only
checks that local Markdown link targets exist on disk and that required
text/URLs are present in the README. External link liveness checking
(confirming the canonical `usethrottle.dev` URLs actually resolve) is a
separate, explicitly opt-in command owned by a later stage of this
project's rollout, not part of `pnpm test` or `pnpm check`. Do not wire
network calls into the default test run.

## Writing new tests

- Prefer the existing per-package `vitest.config.ts` and conventions in that
  package over inventing a new pattern.
- For anything touching webhook verification, identity verification,
  encryption, or uninstall, extend the existing test files in
  `packages/throttle/src`, `packages/security/src`, and
  `packages/adapters-d1/src` rather than re-testing those invariants
  ad hoc elsewhere — see [AGENTS.md](../AGENTS.md#architectural-invariants--do-not-weaken-these).
- New HTTP routes belong in `apps/cloudflare/src/app.test.ts` (or a
  route-specific test file) and should assert both the happy path and the
  authentication/authorization failure paths.
