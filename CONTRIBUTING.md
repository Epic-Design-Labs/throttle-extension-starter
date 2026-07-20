# Contributing

Thanks for improving this starter. This document covers contributing to the
**template itself**. If you are building your own Throttle extension from a
copy of this starter, see the root [README](README.md) instead — most of
what's below (the internal test matrix, workspace boundary rules) is about
keeping the template correct, not about building your product.

## Before you start

- Node.js `>=20` (see `.nvmrc`) and pnpm `10.34.5` (pinned in the root
  `package.json` `packageManager` field — use exactly this version, via
  Corepack, to avoid lockfile drift).
- Install dependencies with `pnpm install`.
- Read [AGENTS.md](AGENTS.md). It lists the invariants (raw-body webhook
  verification, identity JWT verification, credential encryption, workspace
  dependency boundaries, camelCase public contracts) that changes in this
  repository must not weaken, whether you are a human or a coding agent.

## Development loop

1. Make your change.
2. Add or update tests first (this repository practices test-driven
   development — see [docs/testing.md](docs/testing.md)).
3. Run the full local quality gate before opening a PR:

   ```bash
   pnpm check
   ```

   `pnpm check` runs, in order: `format:check`, `lint`, `typecheck`, the full
   test suite (`test`, which runs every package's tests and then the root
   end-to-end/workspace-boundary/documentation tests), and `build` (which
   includes a Cloudflare Worker dry-run deploy). All of it must pass.

4. If you only want to iterate on one package's tests, use
   `pnpm --filter <package-name> test` (see `package.json` → `test:packages`
   for the full list of package names), or scope the root suite with
   `pnpm test -- <path-to-test-file>`.

## Workspace boundaries

`packages/contracts` and `packages/core` are portable: they must never
import `node:*`, `cloudflare:*`, `@cloudflare/*`, `react*`, `postgres*`, or
`wrangler*` modules. This is enforced by
`tests/workspace-boundaries.test.ts` and lets those two packages be reused
by a future Node/Render runtime without change. Runtime-specific code lives
in `apps/cloudflare`, `packages/adapters-d1`, and
`packages/adapters-cloudflare-queue`.

## Database migrations

D1 migrations live in `packages/adapters-d1/migrations/` and are
append-only: never edit a migration that has already been committed. Add a
new numbered migration file instead. See
[docs/cloudflare-deployment.md](docs/cloudflare-deployment.md) for how
migrations are applied locally and in production.

## Commit and PR expectations

- Keep commits focused; prefer several small commits over one large one.
- Write commit messages that explain _why_, not just _what_.
- Do not weaken any of the security invariants in [AGENTS.md](AGENTS.md)
  without an explicit, reviewed reason recorded in the PR description.
- Do not commit real secrets. `.env`, `.dev.vars`, and anything matching
  `dist/` are git-ignored; only ever commit the `.example` variants of
  configuration files.
- New behavior needs new tests. Bug fixes need a regression test that fails
  before the fix and passes after.

## Reporting security issues

Do not open a public issue for a suspected vulnerability. See
[SECURITY.md](SECURITY.md).

## Getting help

Open an issue in this repository for template bugs, documentation gaps, or
feature requests. For questions about the Throttle platform itself, see the
canonical docs linked from the root [README](README.md#support) or contact
`support@usethrottle.dev`.
