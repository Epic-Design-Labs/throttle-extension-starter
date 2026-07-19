# Throttle Extension Starter Design

## Purpose

This repository will be the recommended starting point for external Throttle extensions. Its first real consumer will be a ShipStation connector, but the starter itself remains provider-neutral and useful for embedded-only, webhook-only, and hybrid extensions.

The starter prioritizes a fast path to a working deployment without coupling extension logic to one hosting vendor. Cloudflare is the first fully supported reference runtime because it offers inexpensive hosting for simple connectors. A general Node and PostgreSQL runtime, with a Render deployment blueprint, will follow and is required before the first stable public release.

## Goals

- Provide a complete hybrid extension that includes an embedded dashboard UI and durable backend event processing.
- Let a developer run the complete example locally without a Throttle or third-party provider account.
- Make Cloudflare Workers, D1, and Queues the first tested deployment path.
- Keep connector workflows portable to Node, PostgreSQL, and other hosting environments.
- Demonstrate secure credential storage, verified identity, signed webhooks, idempotency, retries, and observable failures.
- Serve as a GitHub template with a setup command for renaming and tailoring a new extension.
- Give provider adapters, such as the future ShipStation adapter, clear and testable boundaries.
- Provide a complete root README that lets a developer or coding agent understand, configure, run, test, customize, secure, and deploy the starter without access to Throttle's private repositories.

## Non-goals

- Implement ShipStation behavior in this repository.
- Provide adapters for every cloud or database.
- Build a general project-generator CLI in the first release.
- Hide meaningful infrastructure differences behind a lowest-common-denominator abstraction.
- Require a live Throttle installation for basic local development and automated tests.

## Extension Shape

The starter supports both Throttle extension surfaces:

1. An embedded React application runs in the Throttle dashboard iframe. It uses `@usethrottle/extension-bridge` for verified session context, scoped Throttle API calls, resizing, navigation, and dashboard notifications.
2. A backend receives signed Throttle events, acknowledges them promptly, and performs durable asynchronous processing even when the iframe is closed.

An extension created from the starter may remove either surface when it only needs one. The demo exercises both so the complete contract remains tested.

Tutorials, sample configuration, fixtures, and default setup target a Throttle Test-mode environment. Moving to production is a separate, explicitly documented transition with its own preflight checks.

## Repository Architecture

The project is a pnpm TypeScript monorepo with explicit runtime boundaries.

### Applications

- `apps/extension-ui`: React and Vite iframe application.
- `apps/cloudflare`: Hono Worker exposing webhook, embedded-backend, liveness, and readiness routes. It wires D1 and Cloudflare Queues adapters into the portable core.
- `apps/node`: Phase-two Hono Node server. It wires PostgreSQL and a database-backed job runner into the same portable core and includes a Render blueprint.

### Packages

- `packages/core`: Provider-neutral connector use cases, domain types, and dependency interfaces. It imports no Cloudflare, Node, database, or UI framework APIs.
- `packages/contracts`: Shared runtime schemas and TypeScript types for configuration, jobs, API payloads, events, and persisted records.
- `packages/throttle`: Throttle bridge helpers, webhook verification, event normalization, identity verification, and a narrow Throttle API client.
- `packages/adapters-d1`: D1 persistence and encrypted credential storage.
- `packages/adapters-cloudflare-queue`: Cloudflare Queues producer and consumer integration.
- `packages/adapters-postgres`: Phase-two PostgreSQL persistence and encrypted credential storage.
- `packages/adapters-node-jobs`: Phase-two database-backed Node job processing.
- `examples/demo-connector`: Fictional provider adapter and fixtures that demonstrate the complete lifecycle without external side effects.

Package names may be shortened during implementation, but these responsibilities and dependency directions must remain intact. Applications may depend on packages. Adapter packages may depend on contracts and core interfaces. Core must not depend on applications or infrastructure adapters.

## Runtime Interfaces

Core workflows receive infrastructure as explicit dependencies. Initial interfaces cover:

- Installation and environment records
- Non-secret extension configuration
- Encrypted per-install credentials
- Webhook delivery idempotency
- Job enqueueing and job execution state
- Connector activity and error history
- Clock, identifiers, and structured logging where deterministic tests require them

Interfaces model required behavior, not vendor APIs. Cloudflare and Node adapters may expose different operational capabilities outside the portable core when necessary.

## Installation and Configuration Flow

1. A Throttle extension version is installed for one application and workspace environment.
2. The one-time per-install Throttle API key and webhook signing secret are captured through a documented publisher setup flow and stored encrypted by the extension backend. They are never exposed to the embedded browser application.
3. When the iframe opens, the Throttle bridge supplies a short-lived signed session containing the active workspace, application, environment, installation, extension version, user, role, and scopes.
4. The iframe sends provider credentials to the extension backend with its bridge identity token.
5. The backend verifies the token and derives installation identity from verified claims. It does not accept browser-supplied workspace, application, environment, or installation IDs as authority.
6. Provider credentials are encrypted and stored per installation. Non-secret configuration is stored separately so it can be displayed and edited safely.

The bridge context does not contain installation configuration or one-time secrets. The backend remains the source of truth for connector-specific state.

## Webhook Processing Flow

1. The backend reads and preserves the exact raw request body.
2. It performs a limited, non-authoritative parse of the envelope's `workspaceId` and `environmentId` only to load the bounded set of candidate installations for that environment. Throttle's event envelope does not include an installation identifier.
3. It verifies the Throttle signature against those installations' signing secrets. The matching secret establishes the installation identity; no envelope field is trusted and no action is taken before this verification succeeds.
4. It validates the event schema, installation, environment, and declared subscription.
5. It atomically records the delivery identifier. A previously accepted delivery produces a successful no-op response.
6. It enqueues a small normalized job containing identifiers rather than credentials or large payloads, then returns promptly.
7. A queue consumer reloads current installation state, credentials, and configuration and invokes the provider adapter through a core workflow.
8. It records success, retryable failure, or terminal failure for display and operations.

Retries use bounded exponential backoff with explicit attempt limits. Exhausted work remains queryable and visible in the embedded UI. The starter does not silently discard failed jobs.

## Embedded UI

The React application will provide a small, reusable shell with these states:

- Bridge handshake/loading
- Unsupported or invalid host context
- Disconnected provider setup
- Connected configuration
- Recent event and job activity
- Retryable and terminal errors with actionable guidance

The UI calls Throttle through `bridge.api` when the extension's granted scopes permit it. Connector-specific state is requested from the extension backend using the bridge identity token. Production bridge creation pins `targetOrigin` to the configured Throttle dashboard origin.

The UI contains no infrastructure-specific storage logic and no long-lived provider or Throttle secrets.

## Provider Adapter Boundary

A provider adapter owns provider-specific authentication, API calls, field translation, error classification, and capability reporting. Core workflows own installation isolation, orchestration, idempotency, retry policy, and activity recording.

The fictional demo adapter must be deterministic and side-effect-free by default. It demonstrates connection validation and at least one event-to-provider workflow. A future ShipStation project can replace the demo adapter without rewriting Throttle webhook handling, identity verification, persistence, queue orchestration, or the UI shell.

## Security Model

- Verify every webhook over the exact raw body using Web Crypto and the per-install signing secret.
- Verify embedded identity JWT signatures against Throttle JWKS and validate issuer, audience, expiry, and relevant claims before trusting identity.
- Encrypt provider credentials and per-install Throttle secrets using authenticated encryption.
- Store ciphertext, nonce, algorithm version, and key version in D1 or PostgreSQL. Keep the root encryption key in the hosting platform's secret store.
- Bind encrypted data to its installation identity as authenticated context so ciphertext cannot be moved between installations unnoticed.
- Redact credentials, authorization headers, tokens, webhook signatures, secret configuration, and raw encrypted material from logs and errors.
- Isolate records and operations by verified installation and environment identity.
- Validate all external input with shared runtime schemas.
- Return minimal information from liveness and readiness endpoints.
- Document encryption-key rotation, credential replacement, webhook replay behavior, uninstall cleanup, and safe local secret handling.

Cryptography and identity verification use included secure implementations behind narrow services. They are not placeholders for each extension author to invent.

## Persistence Model

The exact schema will be finalized in the implementation plan, but both database adapters must support equivalent records for:

- Installations keyed by `installationId`, including workspace, application, environment or mode, extension version, provider account reference, status, created and updated timestamps, last successful sync cursor, and uninstall timestamp
- Encrypted installation secrets and provider credentials
- Non-secret connector configuration
- Accepted webhook deliveries and idempotency state
- Jobs, attempts, scheduling, and terminal state
- Connector activity and sanitized error summaries

Throttle is authoritative for installation state; the extension is authoritative for provider synchronization state. Schema evolution uses checked-in migrations. D1 and PostgreSQL migrations may differ syntactically but must preserve contract behavior. Uninstall cleanup has an explicit retention policy, removes credentials promptly, and prevents queued or scheduled work for that installation from continuing.

## Portability Strategy

Cloudflare is a reference adapter, not the core architecture.

### Milestone 1: Cloudflare reference runtime

- Cloudflare Workers HTTP runtime
- D1 persistence
- Cloudflare Queues asynchronous processing
- Cloudflare secret binding for the root encryption key
- Local development and integration tests using Cloudflare tooling

### Milestone 2: Node reference runtime

- Standard Node server using the same Hono routes and core workflows where practical
- PostgreSQL persistence
- Database-backed durable job processing without requiring Redis
- Environment variables or a platform secret manager for the root encryption key
- Render blueprint and deployment guide

The Node implementation is described as a Node/PostgreSQL adapter because it should also work on comparable platforms such as Fly.io, Railway, AWS, or Kubernetes. The first stable public release requires both reference runtimes to pass the shared adapter contracts and their own integration tests.

## Error Handling and Observability

Errors are classified into validation, authentication, authorization, configuration, retryable provider, terminal provider, infrastructure, and programmer errors. Public responses are safe and stable; detailed internal errors remain structured and redacted.

Every webhook and job receives correlation fields including request ID, installation ID, environment, event ID and type, extension version, provider account reference, job ID, attempt, duration, and result class. Logs are structured. Activity records provide enough sanitized context for the UI and operators to understand what happened and what action is available.

Liveness only indicates that the process can respond. Readiness checks required dependencies without exposing connection details or secrets.

## Testing Strategy

- Unit tests cover core workflows, schemas, encryption behavior, signature verification, retry classification, and log redaction.
- A shared contract-test suite runs against every persistence, credential, and queue/job adapter.
- Cloudflare integration tests exercise Worker routes, local D1, and queue consumers.
- Phase-two integration tests exercise Node routes, PostgreSQL, and its job runner.
- UI component tests cover bridge loading, configuration, activity, and error states.
- One end-to-end demo test covers signed webhook receipt, idempotency, enqueueing, fake provider execution, persisted activity, and UI-visible status.
- Required failure and lifecycle scenarios include invalid signatures, duplicate and out-of-order events, timeouts, provider `429` and `5xx` responses, provider outages, expired credentials, missing optional fields, pagination, uninstall during queued work, version upgrades, newly requested scope consent, Test/production isolation, and cancellation or return races relevant to fulfillment connectors.
- Test fixtures provide mocked bridge context, signed webhook payloads, and deterministic provider responses.
- CI enforces type checking, linting, formatting, package dependency boundaries, unit tests, contract tests, integration tests, and production builds.

Real Throttle and provider smoke tests may be documented separately, but they are not required for the default local test loop.

## Developer Experience

The repository is distributed as a GitHub template. A setup command will:

- Validate supported tooling versions.
- Rename the example extension and update package and manifest metadata.
- Create ignored local configuration from documented examples without generating production secrets.
- Optionally remove the fictional demo while retaining a minimal provider adapter skeleton.
- Print the next local-development, test, registration, and deployment steps.

The supported toolchain includes Node.js 20 or newer. Local development documents a publicly reachable HTTPS tunnel for real iframe and webhook testing. A committed `.env.example` contains names and safe examples only; one-time installation credentials and provider secrets must never be copied into source-controlled environment files.

One repository per provider integration is the recommended ownership model because integrations have independent credentials, data models, release cycles, deployments, and incident boundaries. A shared monorepo is appropriate only when one team intentionally shares runtime and operational ownership. Projects created from this starter own their copied code and must deliberately pull future security fixes; the starter is not a runtime dependency.

Initial documentation covers architecture, local development, the demo lifecycle, adding a provider, Throttle catalog registration and installation, handling one-time secrets, Cloudflare deployment, migrations, testing, security operations, and troubleshooting. Milestone two adds Node/PostgreSQL configuration and Render deployment.

## Root README Contract

The root `README.md` is the primary onboarding path for human developers and coding agents. It must be useful from a clean clone and must not rely on private Throttle source code or undocumented organizational knowledge.

It includes:

- What Throttle extensions are and when to choose embedded, backend, or hybrid shapes.
- What this starter provides, what the publisher owns, and what the fictional demo does.
- Supported runtime and package-manager versions, prerequisites, repository layout, and dependency boundaries.
- A clean-clone quickstart with verified install, setup, local development, test, build, migration, tunnel, and deployment commands, along with expected local URLs and outcomes.
- Test-mode-first Throttle registration, version publication, installation, iframe verification, test-event delivery, and uninstall steps.
- Configuration and secret inventory explaining which values are public, local-only, platform secrets, per installation, or safe for browser code.
- Instructions for replacing the demo provider, adding events and scopes, evolving schemas, and implementing a new runtime adapter.
- Best practices for least privilege, raw-body signature verification, identity verification, credential encryption, tenant isolation, idempotency, retries, rate limits, pagination, structured redacted logging, uninstall cleanup, data retention, version compatibility, and production readiness.
- Testing guidance and the required failure/lifecycle matrix.
- Deployment paths for Cloudflare and, after milestone two, Node/PostgreSQL with Render.
- Troubleshooting for bridge handshake failures, invalid signatures, migrations, queues, credentials, and environment mismatches.
- Contribution, support, security-reporting, license, and starter-upgrade guidance.
- Canonical links to the Throttle product site, dashboard, extension overview, Get Started, starter-repository guide, Build, Identity JWT, Events, Scopes, Installing, Testing, Versioning, Security, Publishing, Operations, API reference, public packages, and platform status when stable public URLs exist.
- A concise coding-agent guide identifying source-of-truth documents, architectural invariants, commands to run before completion, files that contain generated artifacts, and security rules that must not be weakened.

README commands and external links must be checked from a clean clone before the repository is declared public. The Throttle documentation must not link to the starter until the repository has a stable public URL. Links must use canonical public resources and must not point at private repositories or temporary deployments.

Detailed guides may live under `docs/`, but the README must link them from the relevant onboarding step rather than forcing readers or agents to discover them unaided.

## Delivery Milestones

### Milestone 1: Usable Cloudflare starter

Deliver the monorepo foundation, portable contracts and core, fictional connector, embedded UI, secure Throttle integration, D1 and Queues adapters, encrypted credential storage, local workflow, CI, template setup command, and Cloudflare deployment documentation.

This milestone is sufficient to begin the separate ShipStation extension project.

### Milestone 2: Portability proof and stable release

Deliver the Node/PostgreSQL adapters, database-backed job runner, Render blueprint, shared contract compliance, Node integration tests, and deployment documentation. Resolve any portability leaks found by the second implementation before declaring the starter stable for external developers.

## Acceptance Criteria

- A developer can create a repository from the template and run setup, development, tests, and the fictional connector locally using documented commands.
- A developer or coding agent with no private Throttle repository access can follow the root README from a clean clone to a running, tested local extension and understand the safe customization boundaries.
- The demo iframe works with a mocked bridge locally and with the real Throttle bridge when installed.
- A valid signed demo webhook is acknowledged once, processed asynchronously, and reflected in persisted activity visible to the UI.
- Invalid signatures, invalid identity tokens, cross-install access, duplicate deliveries, missing credentials, and exhausted retries have automated coverage.
- No long-lived secret is sent to browser code or emitted in logs.
- Core and contracts contain no imports from Cloudflare, Node runtime APIs, D1, PostgreSQL, or React.
- The Cloudflare reference deployment passes its integration and end-to-end tests in milestone one.
- Both Cloudflare and Node/PostgreSQL implementations pass shared adapter contracts before the first stable public release.
- Removing the demo leaves a compiling, tested provider skeleton and documented extension points.
- All public Throttle-facing request and response fields use strict camelCase.
- Marketplace preflight documentation covers HTTPS, least-privilege scopes, clean install and uninstall, replay safety, health checks, safe screenshots, support/privacy/terms URLs, production smoke testing, and a named operational owner.
- Operations documentation covers queue and webhook lag, provider availability and credential health, poison events and dead letters, incident response, suspension or delisting, backward-compatible changes, deprecation, data export and deletion, and credential rotation.
