# Security Policy

This repository is a starter template for building Throttle extensions on
Cloudflare Workers. It ships several load-bearing security behaviors
(webhook signature verification, identity JWT verification, credential
encryption, uninstall cleanup) that every extension built from this starter
inherits. Treat vulnerabilities in this template as vulnerabilities in every
downstream extension until they are patched and re-pulled.

## Reporting a vulnerability

Do **not** open a public GitHub issue for a suspected security
vulnerability. Instead, email:

**support@usethrottle.dev**

Include, if possible:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a minimal proof of concept.
- The commit SHA or tag you tested against.
- Whether the issue is in the starter template itself or in your downstream
  copy (see [Ownership model](#ownership-model) below).

We will acknowledge reports and work with you on a fix and coordinated
disclosure timeline.

## Ownership model

This starter is designed to be **copied, not depended on** as a runtime
package (see the "One repository per integration" section of the root
[README](README.md#one-repository-per-provider-integration)). That means a
security fix landing here does not automatically reach any extension already
built from a copy of this template — each downstream repository's
maintainers are responsible for pulling security-relevant fixes deliberately.
When we fix a vulnerability here, we will call it out clearly in the fix's
commit message and changelog entry so downstream repositories can find and
apply it.

## Supported versions

Only the latest commit on the default branch of this starter is supported.
There are no maintained release branches. If you have forked this starter
into a product repository, you own backporting fixes into your fork.

## Scope

In scope:

- The Cloudflare Worker backend (`apps/cloudflare`) and the packages it
  depends on (`packages/*`), including webhook signature verification,
  identity (JWT) verification, credential encryption, and the D1 schema and
  queue consumer.
- The embedded extension UI (`apps/extension-ui`), including the
  `postMessage` bridge integration.
- The customization script (`scripts/setup.mjs`).

Out of scope:

- The Throttle platform itself (dashboard, API, JWKS endpoint). Report those
  issues through the same `support@usethrottle.dev` address; the Throttle
  team will route them appropriately.
- The fictional demo provider (`examples/demo-connector`) is sample code
  publishers are expected to delete or replace; it intentionally has no
  real external side effects.

## What we consider a security-relevant change

Because this is a template, "security-relevant" includes anything that would
weaken an invariant a downstream extension relies on without that extension's
maintainer opting in, for example:

- Any change to webhook signature verification (raw-body handling, the HMAC
  algorithm, timestamp tolerance, or constant-time comparison).
- Any change to identity JWT verification (issuer/audience/expiry/algorithm
  checks, JWKS handling).
- Any change to how credentials are encrypted or scoped to an installation.
- Any change to uninstall cleanup (secret deletion, queued-work
  cancellation).
- Any change to tenant/installation scoping in the D1 adapters or HTTP
  routes.

See [AGENTS.md](AGENTS.md) for the exact rules that must not be weakened, and
[docs/operations.md](docs/operations.md) for incident-response and key
rotation procedures.
