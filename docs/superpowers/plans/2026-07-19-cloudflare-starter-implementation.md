# Cloudflare Throttle Extension Starter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a public, test-mode-first Throttle hybrid-extension template with a React iframe, portable TypeScript core, secure Cloudflare Worker backend, D1 persistence, Queues processing, fictional demo connector, verified onboarding, and production-minded security defaults.

**Architecture:** A pnpm workspace keeps portable contracts and workflows separate from Cloudflare adapters and the React UI. Hono exposes Web `Request`/`Response` routes; D1 and Cloudflare Queues implement narrow core ports; all browser-to-backend identity and inbound Throttle webhooks are verified before trusted work occurs. This plan delivers Milestone 1 only; Node/PostgreSQL/Render is a separate plan after these adapter contracts have been exercised.

**Tech Stack:** Node.js 20+, pnpm 11, TypeScript 7, React 19, Vite 8, Hono 4, Zod 4, Vitest 4, Wrangler 4, Cloudflare Workers/D1/Queues, Web Crypto, `jose`, and `@usethrottle/extension-bridge` 1.1.

---

## File Map

- Root config (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc.json`) owns workspace-wide commands and standards.
- `packages/contracts/src/*` owns public camelCase schemas and shared data types only.
- `packages/core/src/*` owns ports, provider contracts, error classes, retry policy, and event orchestration with no runtime/vendor imports.
- `packages/throttle/src/*` owns Throttle signature verification, JWT verification, bridge-facing types, and event normalization.
- `packages/security/src/*` owns portable authenticated encryption and redaction.
- `packages/adapters-d1/src/*` and `migrations/*` own D1 persistence implementations.
- `packages/adapters-cloudflare-queue/src/*` owns Cloudflare queue production/consumption.
- `examples/demo-connector/src/*` owns deterministic fictional provider behavior.
- `apps/cloudflare/src/*` is the composition root and HTTP/queue entry point.
- `apps/extension-ui/src/*` is the embedded React application and local bridge mock.
- `scripts/setup.mjs` customizes a repository created from the template.
- `docs/*` contains detailed guides; `README.md` remains the complete onboarding index.

### Task 1: Scaffold the pnpm workspace and quality gates

**Files:**
- Modify: `README.md`
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.prettierrc.json`
- Create: `eslint.config.js`
- Create: `.nvmrc`
- Create: `.env.example`
- Create: `.github/workflows/ci.yml`
- Test: `tests/workspace-boundaries.test.ts`

- [ ] **Step 1: Write the failing workspace-boundary test**

```ts
// tests/workspace-boundaries.test.ts
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  }));
  return nested.flat().filter((path) => /\.[cm]?[jt]sx?$/.test(path));
}

describe('portable package boundaries', () => {
  it.each(['packages/contracts/src', 'packages/core/src'])('%s has no runtime imports', async (dir) => {
    for (const file of await sourceFiles(dir)) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/cloudflare:|node:|@cloudflare|react|postgres|wrangler/);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails before workspace setup**

Run: `corepack enable && pnpm test -- tests/workspace-boundaries.test.ts`

Expected: FAIL because no root package or Vitest command exists.

- [ ] **Step 3: Create the root workspace configuration**

```json
// package.json
{
  "name": "throttle-extension-starter",
  "private": true,
  "packageManager": "pnpm@11.15.0",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "pnpm -r build",
    "check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build",
    "dev": "pnpm --parallel --filter @starter/cloudflare --filter @starter/extension-ui dev",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "lint": "eslint .",
    "setup": "node scripts/setup.mjs",
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "@eslint/js": "latest",
    "eslint": "latest",
    "prettier": "latest",
    "typescript": "^7.0.2",
    "typescript-eslint": "latest",
    "vitest": "^4.1.10"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
  - examples/*
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "declaration": true,
    "skipLibCheck": true
  }
}
```

Create `.nvmrc` containing `20`, `.prettierrc.json` containing `{ "singleQuote": true, "trailingComma": "all" }`, a flat ESLint config enabling TypeScript recommended rules, and `.env.example` with names only: `THROTTLE_BASE_URL`, `THROTTLE_DASHBOARD_ORIGIN`, `THROTTLE_JWKS_URL`, and `LOCAL_ENCRYPTION_KEY`.

- [ ] **Step 4: Create CI with one authoritative check command**

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - uses: pnpm/action-setup@v4
        with: { version: 11.15.0 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
```

- [ ] **Step 5: Install and verify the root checks**

Run: `pnpm install && pnpm test -- tests/workspace-boundaries.test.ts`

Expected: PASS after the package source directories are created with placeholder `index.ts` exports as part of this task.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.js .prettierrc.json .nvmrc .env.example .github tests README.md packages/*/src/index.ts
git commit -m "chore: scaffold extension starter workspace"
```

### Task 2: Define shared public contracts

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/installation.ts`
- Create: `packages/contracts/src/events.ts`
- Create: `packages/contracts/src/jobs.ts`
- Create: `packages/contracts/src/activity.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/contracts.test.ts`

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, it } from 'vitest';
import { installationSchema, throttleEventSchema } from './index.js';

describe('contracts', () => {
  it('accepts strict camelCase installation records', () => {
    expect(installationSchema.parse({
      installationId: 'inst_1', workspaceId: 'ws_1', applicationId: 'app_1',
      environmentId: 'env_1', environmentKind: 'non_production', extensionVersion: '0.1.0',
      status: 'active', createdAt: '2026-07-19T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z',
    }).installationId).toBe('inst_1');
  });

  it('rejects retired snake_case fields', () => {
    expect(() => installationSchema.parse({ installation_id: 'inst_1' })).toThrow();
  });

  it('preserves the Throttle event envelope', () => {
    expect(throttleEventSchema.parse({
      id: 'evt_1', type: 'order.created', workspaceId: 'ws_1', environmentId: 'env_1',
      createdAt: '2026-07-19T00:00:00.000Z', data: { orderId: 'ord_1' },
    }).type).toBe('order.created');
  });
});
```

- [ ] **Step 2: Run the test and confirm missing schemas**

Run: `pnpm --filter @starter/contracts test`

Expected: FAIL because the schemas are not exported.

- [ ] **Step 3: Implement strict Zod contracts**

Define `installationSchema`, `throttleEventSchema`, `connectorJobSchema`, and `activitySchema`. Use `.strict()`, ISO datetime strings, explicit status enums, and camelCase property names. Infer and export matching TypeScript types. `connectorJobSchema` contains identifiers and event data but never credentials.

```ts
export const installationSchema = z.object({
  installationId: z.string().min(1), workspaceId: z.string().min(1), applicationId: z.string().min(1),
  environmentId: z.string().min(1), environmentKind: z.enum(['production', 'non_production']),
  extensionVersion: z.string().min(1), providerAccountReference: z.string().optional(),
  status: z.enum(['pending', 'active', 'disconnected', 'uninstalled']),
  lastSuccessfulSyncCursor: z.string().optional(), createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(), uninstallAt: z.string().datetime().optional(),
}).strict();
```

- [ ] **Step 4: Run contract tests and type checking**

Run: `pnpm --filter @starter/contracts test && pnpm --filter @starter/contracts typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat: define extension data contracts"
```

### Task 3: Define portable core ports and errors

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/ports.ts`
- Create: `packages/core/src/provider.ts`
- Create: `packages/core/src/retry.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/retry.test.ts`

- [ ] **Step 1: Write failing retry-policy tests**

```ts
import { describe, expect, it } from 'vitest';
import { classifyProviderFailure, retryDelaySeconds } from './index.js';

describe('provider retry policy', () => {
  it.each([429, 500, 502, 503, 504])('retries HTTP %s', (status) => {
    expect(classifyProviderFailure(status)).toBe('retryable');
  });
  it.each([400, 401, 403, 404, 422])('does not blindly retry HTTP %s', (status) => {
    expect(classifyProviderFailure(status)).toBe('terminal');
  });
  it('uses bounded exponential backoff', () => {
    expect([1, 2, 3, 10].map(retryDelaySeconds)).toEqual([5, 25, 125, 900]);
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @starter/core test`

Expected: FAIL because retry functions are missing.

- [ ] **Step 3: Implement ports and error taxonomy**

Define focused interfaces `InstallationStore`, `CredentialStore`, `DeliveryStore`, `JobQueue`, `ActivityStore`, `ProviderConnector`, `Clock`, and `Logger`. Define `ValidationError`, `AuthenticationError`, `AuthorizationError`, `ConfigurationError`, `RetryableProviderError`, `TerminalProviderError`, and `InfrastructureError` with safe public codes. Implement retry delays capped at 900 seconds and a maximum of five attempts.

```ts
export interface ProviderConnector {
  validateCredentials(credentials: Uint8Array): Promise<{ providerAccountReference: string }>;
  handleEvent(input: { event: ThrottleEvent; credentials: Uint8Array; configuration: unknown }): Promise<void>;
}
```

- [ ] **Step 4: Run core and boundary tests**

Run: `pnpm --filter @starter/core test && pnpm test -- tests/workspace-boundaries.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core tests/workspace-boundaries.test.ts
git commit -m "feat: define portable connector ports"
```

### Task 4: Implement encryption and structured redaction

**Files:**
- Create: `packages/security/package.json`
- Create: `packages/security/tsconfig.json`
- Create: `packages/security/src/encryption.ts`
- Create: `packages/security/src/redaction.ts`
- Create: `packages/security/src/index.ts`
- Test: `packages/security/src/encryption.test.ts`
- Test: `packages/security/src/redaction.test.ts`

- [ ] **Step 1: Write failing security tests**

```ts
it('round-trips only with matching installation context', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const encrypted = await encryptSecret(new TextEncoder().encode('secret'), key, 'inst_1');
  await expect(decryptSecret(encrypted, key, 'inst_1')).resolves.toEqual(new TextEncoder().encode('secret'));
  await expect(decryptSecret(encrypted, key, 'inst_2')).rejects.toThrow();
});

it('redacts nested sensitive fields', () => {
  expect(redact({ authorization: 'Bearer x', nested: { apiKey: 'x', ok: 1 } }))
    .toEqual({ authorization: '[REDACTED]', nested: { apiKey: '[REDACTED]', ok: 1 } });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @starter/security test`

Expected: FAIL because encryption and redaction are missing.

- [ ] **Step 3: Implement AES-256-GCM with installation-bound additional data**

Use Web Crypto only. Store `{ algorithm: 'A256GCM', keyVersion, iv, ciphertext }` with base64url encoding. Import the 32-byte root key as non-extractable, use a fresh 12-byte IV, and pass `installationId` as `additionalData`. Redact keys matching `authorization`, `apiKey`, `token`, `secret`, `signature`, `credential`, `password`, and ciphertext fields recursively.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @starter/security test && pnpm --filter @starter/security typecheck`

Expected: PASS, including tamper and wrong-context rejection.

- [ ] **Step 5: Commit**

```bash
git add packages/security
git commit -m "feat: add portable secret encryption"
```

### Task 5: Implement Throttle webhook and identity verification

**Files:**
- Create: `packages/throttle/package.json`
- Create: `packages/throttle/tsconfig.json`
- Create: `packages/throttle/src/webhooks.ts`
- Create: `packages/throttle/src/identity.ts`
- Create: `packages/throttle/src/events.ts`
- Modify: `packages/throttle/src/index.ts`
- Test: `packages/throttle/src/webhooks.test.ts`
- Test: `packages/throttle/src/identity.test.ts`

- [ ] **Step 1: Write failing webhook tests using fixed fixtures**

Test `t=<unix-seconds>,v1=<hex-hmac-sha256>` over `<t>.<rawBody>`, rejection of altered bodies, malformed headers, and timestamps outside a configurable five-minute tolerance. Assert comparison does not short-circuit on the first mismatched byte.

- [ ] **Step 2: Write failing JWT tests**

Generate an ephemeral RSA key pair with `jose`, expose its public JWK through a stubbed JWKS fetcher, and test issuer, audience, expiry, installation ID, environment, and scope validation. Include invalid-signature and wrong-audience cases.

- [ ] **Step 3: Run and verify failures**

Run: `pnpm --filter @starter/throttle test`

Expected: FAIL because verifier exports are missing.

- [ ] **Step 4: Implement the verifiers**

Use Web Crypto HMAC SHA-256 and a constant-time byte comparison for webhooks. Parse only `workspaceId` and `environmentId` from the untrusted envelope for candidate-secret lookup; return no trusted event until a candidate secret verifies. Use `jose` remote/local JWK set primitives for RS256 identity JWTs and return a narrow verified context.

```ts
export type VerifiedExtensionIdentity = {
  installationId: string; extensionId: string; version: string; workspaceId: string;
  applicationId: string; environmentId: string; role: string; scopes: string[];
};
```

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @starter/throttle test && pnpm --filter @starter/throttle typecheck`

Expected: PASS.

```bash
git add packages/throttle
git commit -m "feat: verify throttle webhooks and identity"
```

### Task 6: Implement D1 schema and adapter contracts

**Files:**
- Create: `packages/adapters-d1/package.json`
- Create: `packages/adapters-d1/tsconfig.json`
- Create: `packages/adapters-d1/migrations/0001_initial.sql`
- Create: `packages/adapters-d1/src/database.ts`
- Create: `packages/adapters-d1/src/installations.ts`
- Create: `packages/adapters-d1/src/credentials.ts`
- Create: `packages/adapters-d1/src/deliveries.ts`
- Create: `packages/adapters-d1/src/activities.ts`
- Create: `packages/adapters-d1/src/index.ts`
- Create: `packages/core/src/contract-tests.ts`
- Test: `packages/adapters-d1/src/adapters.test.ts`

- [ ] **Step 1: Write reusable adapter contract tests**

Export suites that accept an adapter factory and verify installation isolation, environment isolation, credential replacement, duplicate-delivery atomicity, activity ordering, and uninstall cleanup. The duplicate test launches two concurrent `acceptDelivery` calls and asserts exactly one returns `accepted: true`.

- [ ] **Step 2: Run D1 adapter tests and verify failure**

Run: `pnpm --filter @starter/adapters-d1 test`

Expected: FAIL because the migration and adapters do not exist.

- [ ] **Step 3: Create the D1 migration**

Create normalized `installations`, `secrets`, `deliveries`, `jobs`, and `activities` tables. Use `installation_id` foreign keys internally, unique `(installation_id, event_id)` delivery constraints, indexes for workspace/environment candidate lookup and recent activity, and an uninstall timestamp. Public TypeScript fields remain camelCase even though SQL uses snake_case.

- [ ] **Step 4: Implement D1 adapters**

Map database rows explicitly to strict contract schemas. Credential writes encrypt before SQL and zero temporary plaintext buffers after provider calls where practical. `markUninstalled` atomically changes installation state, deletes secrets, and cancels queued database job records.

- [ ] **Step 5: Run migration and contract tests**

Run: `pnpm --filter @starter/adapters-d1 test`

Expected: PASS for every shared contract.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/contract-tests.ts packages/adapters-d1
git commit -m "feat: add install-aware d1 persistence"
```

### Task 7: Implement event orchestration and the demo provider

**Files:**
- Create: `packages/core/src/process-event.ts`
- Create: `packages/core/src/connect-provider.ts`
- Modify: `packages/core/src/index.ts`
- Create: `examples/demo-connector/package.json`
- Create: `examples/demo-connector/tsconfig.json`
- Create: `examples/demo-connector/src/demo-provider.ts`
- Create: `examples/demo-connector/src/index.ts`
- Test: `packages/core/src/process-event.test.ts`
- Test: `examples/demo-connector/src/demo-provider.test.ts`

- [ ] **Step 1: Write the failing orchestration tests**

Cover active installation success, duplicate no-op, disconnected installation, retryable provider failure, terminal provider failure, and uninstall between enqueue and execution. Assert activity records contain sanitized codes, not raw provider bodies or credentials.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @starter/core test -- process-event`

Expected: FAIL because `processConnectorEvent` is missing.

- [ ] **Step 3: Implement the minimal workflow**

`connectProvider` validates credentials before storage and records the returned provider account reference. `processConnectorEvent` reloads current installation/config/credentials, refuses non-active installations, calls the provider, records success, and converts classified errors into retry/terminal outcomes without logging secrets.

- [ ] **Step 4: Implement the deterministic demo provider**

Use credentials equal to UTF-8 `demo-valid` as valid, return provider account `demo-account`, record accepted `order.created` IDs in an injected in-memory sink, and expose deterministic modes for 429, 500, expired credential, timeout, pagination, and malformed optional data tests.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @starter/core test && pnpm --filter @starter/demo-connector test`

Expected: PASS.

```bash
git add packages/core examples/demo-connector
git commit -m "feat: add portable event workflow and demo connector"
```

### Task 8: Implement Cloudflare Queue adapters

**Files:**
- Create: `packages/adapters-cloudflare-queue/package.json`
- Create: `packages/adapters-cloudflare-queue/tsconfig.json`
- Create: `packages/adapters-cloudflare-queue/src/producer.ts`
- Create: `packages/adapters-cloudflare-queue/src/consumer.ts`
- Create: `packages/adapters-cloudflare-queue/src/index.ts`
- Test: `packages/adapters-cloudflare-queue/src/queue.test.ts`

- [ ] **Step 1: Write failing producer and consumer tests**

Assert the producer validates job schemas and emits identifier-only payloads. Assert the consumer acknowledges success/terminal failure, retries retryable failure with the core delay, caps at five attempts, and acknowledges stale jobs for uninstalled installations.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @starter/adapters-cloudflare-queue test`

Expected: FAIL because adapters are missing.

- [ ] **Step 3: Implement Cloudflare Queue wiring**

Wrap the structural subset of Cloudflare `Queue`, `Message`, and `MessageBatch` used by the adapter so unit tests need no global runtime. Persist an activity before retrying or dead-lettering. Never put decrypted credentials in a message.

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @starter/adapters-cloudflare-queue test`

Expected: PASS.

```bash
git add packages/adapters-cloudflare-queue
git commit -m "feat: add cloudflare queue processing"
```

### Task 9: Compose the Cloudflare Worker HTTP API

**Files:**
- Create: `apps/cloudflare/package.json`
- Create: `apps/cloudflare/tsconfig.json`
- Create: `apps/cloudflare/wrangler.jsonc`
- Create: `apps/cloudflare/src/env.ts`
- Create: `apps/cloudflare/src/app.ts`
- Create: `apps/cloudflare/src/routes/webhooks.ts`
- Create: `apps/cloudflare/src/routes/connector.ts`
- Create: `apps/cloudflare/src/routes/health.ts`
- Create: `apps/cloudflare/src/index.ts`
- Test: `apps/cloudflare/src/app.test.ts`

- [ ] **Step 1: Write failing route tests**

Test `GET /health/live`, `GET /health/ready`, `POST /webhooks/throttle`, `GET /api/installation`, `PUT /api/installation/secrets`, `GET /api/connector`, `PUT /api/connector/credentials`, `GET /api/activity`, and `DELETE /api/connector`. Include invalid signature, invalid JWT, cross-install token, duplicate event, missing credentials, repeated installation bootstrap, and uninstalled installation cases.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @starter/cloudflare test`

Expected: FAIL because the app factory is missing.

- [ ] **Step 3: Implement the Hono app factory**

Pass all dependencies into `createApp(dependencies)` for deterministic tests. Preserve `request.text()` before webhook parsing. Use untrusted workspace/environment only to load bounded secret candidates; accept the matching installation only after signature verification. Require verified identity JWTs on every `/api/*` route and derive installation identity from claims.

`PUT /api/installation/secrets` is the authenticated first-run bootstrap. It accepts the one-time Throttle installation API key and webhook signing secret over HTTPS, derives installation/workspace/application/environment/version from the verified bridge JWT, encrypts both values immediately, and returns no secret material. It uses password inputs only as transient transport: the UI must not persist them in state longer than submission, logs, storage, URLs, analytics, or screenshots. Replacing stored values requires an explicit confirmation flag and creates a sanitized rotation activity.

- [ ] **Step 4: Add safe error and logging middleware**

Map known errors to stable JSON `{ error: { code, message, requestId } }`, return generic 500 responses for programmer errors, redact structured logs, and add request IDs. Liveness has no dependency access; readiness runs a minimal D1 query and reports only ready/not-ready.

- [ ] **Step 5: Configure bindings**

Define D1 `DB`, Queue producer/consumer `CONNECTOR_QUEUE`, `THROTTLE_DASHBOARD_ORIGIN`, `THROTTLE_JWKS_URL`, `THROTTLE_JWT_ISSUER`, `THROTTLE_JWT_AUDIENCE`, and secret `ENCRYPTION_KEY`. Use placeholder database/queue IDs in checked-in config and document replacement.

- [ ] **Step 6: Run tests, local migration, and build**

Run: `pnpm --filter @starter/cloudflare test && pnpm --filter @starter/cloudflare db:migrate:local && pnpm --filter @starter/cloudflare build`

Expected: PASS; local D1 migration applies once; Wrangler dry-run bundle succeeds.

- [ ] **Step 7: Commit**

```bash
git add apps/cloudflare
git commit -m "feat: expose secure cloudflare extension backend"
```

### Task 10: Build the embedded React UI and local bridge mock

**Files:**
- Create: `apps/extension-ui/package.json`
- Create: `apps/extension-ui/tsconfig.json`
- Create: `apps/extension-ui/vite.config.ts`
- Create: `apps/extension-ui/index.html`
- Create: `apps/extension-ui/src/bridge.ts`
- Create: `apps/extension-ui/src/api.ts`
- Create: `apps/extension-ui/src/App.tsx`
- Create: `apps/extension-ui/src/components/ConnectionPanel.tsx`
- Create: `apps/extension-ui/src/components/ActivityList.tsx`
- Create: `apps/extension-ui/src/main.tsx`
- Create: `apps/extension-ui/src/styles.css`
- Test: `apps/extension-ui/src/App.test.tsx`

- [ ] **Step 1: Write failing UI state tests**

Using Testing Library, cover bridge loading, invalid host, missing installation-secret bootstrap, disconnected provider credential form, connected provider account, recent activity, retryable failure, terminal failure, secret rotation confirmation, and credential submission. Assert secret input values never render into status/activity output or browser storage.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm --filter @starter/extension-ui test`

Expected: FAIL because `App` is missing.

- [ ] **Step 3: Implement one bridge lifecycle**

Create the bridge once, pin `targetOrigin` from `VITE_THROTTLE_DASHBOARD_ORIGIN`, await `bridge.ready`, call the documented `bridge.getToken()` immediately before each publisher-backend request, and destroy the bridge on unmount. The bridge handles its 10-minute token refresh cycle; a request receiving `401` obtains the current token once and retries once. In `VITE_USE_MOCK_BRIDGE=true`, use a clearly labeled local mock with non-production identity.

- [ ] **Step 4: Implement accessible UI states**

Use semantic forms, status regions, error summaries, visible environment badges, and no provider-specific branding. The first-run form accepts the one-time Throttle API key and signing secret in password fields and submits them directly to the authenticated backend without persistence; provider credentials use the same transient treatment. The backend API client sends the bridge bearer token, never installation IDs as authority. Call `bridge.resize()` after meaningful layout changes and use dashboard toasts only for completed user actions.

- [ ] **Step 5: Run tests and production build**

Run: `pnpm --filter @starter/extension-ui test && pnpm --filter @starter/extension-ui build`

Expected: PASS and Vite emits a static production bundle.

- [ ] **Step 6: Commit**

```bash
git add apps/extension-ui
git commit -m "feat: add embedded connector management ui"
```

### Task 11: Add a complete local end-to-end test

**Files:**
- Create: `tests/e2e/demo-extension.test.ts`
- Create: `tests/fixtures/throttle-events/order-created.json`
- Create: `tests/helpers/sign-webhook.ts`
- Create: `tests/helpers/test-system.ts`

- [ ] **Step 1: Write the end-to-end test**

Build an in-process system with temporary D1, fake queue, demo provider, fixed clock, and generated identity key. Register an installation and encrypted secrets, deliver a signed `order.created`, assert 2xx, deliver it again, assert no second job, drain the queue, and assert exactly one success activity is returned through the authenticated activity endpoint.

- [ ] **Step 2: Add lifecycle variants**

In the same suite test invalid signatures, cross-install JWTs, out-of-order event timestamps, 429 retry, five-attempt exhaustion, credential expiry, and uninstall before queue drain. Each assertion must check externally observable response/job/activity state rather than private method calls.

- [ ] **Step 3: Run and verify failures before completing test helpers**

Run: `pnpm test -- tests/e2e/demo-extension.test.ts`

Expected: FAIL until the test-system composition helpers provide all dependencies.

- [ ] **Step 4: Complete helpers and make the suite pass**

Run: `pnpm test -- tests/e2e/demo-extension.test.ts`

Expected: PASS with no network access.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e tests/fixtures tests/helpers
git commit -m "test: cover hybrid extension lifecycle"
```

### Task 12: Implement the GitHub-template setup command

**Files:**
- Create: `scripts/setup.mjs`
- Create: `scripts/lib/template-files.mjs`
- Test: `scripts/setup.test.ts`

- [ ] **Step 1: Write failing setup tests in temporary directories**

Test non-interactive arguments `--name`, `--slug`, and `--remove-demo`; validation of lowercase slugs; replacement only in declared template files; creation of ignored `.dev.vars`; preservation of `.env.example`; demo removal leaving a compiling provider skeleton; and refusal to run twice without `--force`.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- scripts/setup.test.ts`

Expected: FAIL because the script is missing.

- [ ] **Step 3: Implement deterministic setup**

Use Node standard library only. Maintain an explicit allowlist of files and replacement tokens. Never generate or print production secrets. End by printing exact `pnpm dev`, `pnpm test`, local migration, tunnel, Throttle registration, and deploy next steps.

- [ ] **Step 4: Run setup tests and a dry run**

Run: `pnpm test -- scripts/setup.test.ts && pnpm setup -- --name "Example Connector" --slug example-connector --dry-run`

Expected: PASS and a change summary with no filesystem mutations during dry-run.

- [ ] **Step 5: Commit**

```bash
git add scripts package.json
git commit -m "feat: add starter customization command"
```

### Task 13: Write the complete developer and coding-agent documentation

**Files:**
- Replace: `README.md`
- Create: `AGENTS.md`
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `LICENSE`
- Create: `docs/architecture.md`
- Create: `docs/local-development.md`
- Create: `docs/cloudflare-deployment.md`
- Create: `docs/adding-a-provider.md`
- Create: `docs/testing.md`
- Create: `docs/operations.md`
- Test: `tests/documentation.test.ts`

- [ ] **Step 1: Write failing documentation contract tests**

Parse README Markdown links and assert required local targets exist. Assert README contains verified command strings from `package.json`, all required Throttle canonical URLs, Test-mode guidance, secret classification, raw-body verification, identity verification, idempotency, uninstall cleanup, provider replacement, Cloudflare deployment, troubleshooting, and coding-agent guidance. Make external HTTP link checking an explicit opt-in command, not part of offline unit tests.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- tests/documentation.test.ts`

Expected: FAIL against the initial one-line README.

- [ ] **Step 3: Write README as the complete onboarding index**

Follow the approved Root README Contract in the design spec. Include a five-minute mocked quickstart, real Test-mode install path, exact secret table, repository map, customization recipe, required checks, Cloudflare deploy path, Node/Render roadmap, best practices, troubleshooting, support/security/license, and coding-agent section. Link every detailed guide at its point of use.

Use canonical public links rooted at:

```text
https://usethrottle.dev
https://app.usethrottle.dev
https://docs.usethrottle.dev/developers/extensions/overview
https://docs.usethrottle.dev/developers/extensions/get-started
https://docs.usethrottle.dev/developers/extensions/starter-repository
https://docs.usethrottle.dev/developers/extensions/build
https://docs.usethrottle.dev/developers/extensions/identity
https://docs.usethrottle.dev/developers/extensions/events
https://docs.usethrottle.dev/developers/extensions/scopes
https://docs.usethrottle.dev/developers/extensions/install
https://docs.usethrottle.dev/developers/extensions/testing
https://docs.usethrottle.dev/developers/extensions/versioning
https://docs.usethrottle.dev/developers/extensions/security
https://docs.usethrottle.dev/developers/extensions/publishing
https://docs.usethrottle.dev/developers/extensions/operations
https://docs.usethrottle.dev/developers/api-reference
https://docs.usethrottle.dev/developers/packages
```

Confirm any status-page URL with the Throttle team before adding it; do not invent one.

- [ ] **Step 4: Write focused supporting guides and agent rules**

`AGENTS.md` states source-of-truth docs, dependency invariants, raw-body/JWT/secret rules, camelCase public contract, TDD/check commands, migration ownership, generated-file policy, and prohibited shortcuts. Supporting guides expand architecture, local tunnel/install, provider adapters, testing matrix, Cloudflare deployment, incident response, data deletion, rotation, compatibility, and deprecation.

- [ ] **Step 5: Verify docs offline and commands from a clean clone**

Run: `pnpm test -- tests/documentation.test.ts && pnpm check`

Expected: PASS.

Then create a temporary clean clone, follow README commands exactly through mocked local startup and tests, and record corrections in the README before continuing. Do not publish or deploy from the temporary clone.

- [ ] **Step 6: Check public links when network access is available**

Run: `pnpm docs:check-links`

Expected: Every included canonical link returns a non-error response. If a planned Throttle docs route is not deployed yet, label it as forthcoming in a non-clickable roadmap section rather than shipping a dead link.

- [ ] **Step 7: Commit**

```bash
git add README.md AGENTS.md CONTRIBUTING.md SECURITY.md LICENSE docs tests/documentation.test.ts package.json
git commit -m "docs: add complete extension developer onboarding"
```

### Task 14: Perform release hardening and Cloudflare smoke verification

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/cloudflare-deployment.md`
- Create: `docs/release-checklist.md`
- Create: `scripts/verify-release.mjs`
- Test: `scripts/verify-release.test.ts`

- [ ] **Step 1: Write a failing release-verifier test**

Use a fixture repository missing one required artifact and assert the verifier reports it. Required artifacts include lockfile, migrations, `.env.example`, `.dev.vars.example`, Wrangler config, README, security policy, license, passing check command, and no tracked `.dev.vars` or credential-like values.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- scripts/verify-release.test.ts`

Expected: FAIL because the verifier is missing.

- [ ] **Step 3: Implement release verification and checklist**

The script checks required files, forbidden tracked secret files, placeholder Cloudflare IDs, unresolved documentation markers, package boundary tests, clean generated output, and exact README commands. The checklist covers Test-mode clean install/uninstall, least scopes, replay safety, HTTPS, health checks, screenshots without customer data, privacy/terms/support URLs, production smoke test, rollback, data deletion, credential rotation, and operational owner.

- [ ] **Step 4: Run full offline verification**

Run: `pnpm check && pnpm verify:release`

Expected: PASS except an intentional warning that production Cloudflare IDs and public repository URL must be supplied by the publisher.

- [ ] **Step 5: Run an authorized Cloudflare Test-mode smoke deployment**

After the user supplies/authorizes a Cloudflare account, stable repository URL, and Throttle Test-mode installation, apply remote D1 migrations, set secrets interactively, deploy the Worker/UI, open liveness/readiness, complete bridge handshake, send a signed test event, replay it, inspect activity, and uninstall. Do not perform this step with production customer data.

Expected: One provider action for original plus replayed event, successful iframe identity, no work after uninstall, and no secrets in logs.

- [ ] **Step 6: Add smoke findings and rerun checks**

Run: `pnpm check && pnpm verify:release && git diff --check`

Expected: PASS with documentation matching observed commands and URLs.

- [ ] **Step 7: Commit**

```bash
git add .github README.md docs/cloudflare-deployment.md docs/release-checklist.md scripts package.json
git commit -m "chore: harden cloudflare starter release"
```

## Milestone 1 Completion Gate

Before declaring the Cloudflare starter complete:

1. Run `pnpm check` and retain the passing output.
2. Run `pnpm verify:release` and resolve every error.
3. Follow the README from a clean clone with no private Throttle repository access.
4. Complete the authorized Throttle Test-mode/Cloudflare smoke flow.
5. Confirm the root README contains no dead links or unverified commands.
6. Confirm no long-lived secret reaches browser code, fixtures, logs, git history, or queue messages.
7. Confirm duplicate, out-of-order, retry, exhaustion, cross-install, environment-isolation, and uninstall-during-work scenarios pass.
8. Request code review before merging or publishing the template.

Milestone 2 begins with a fresh implementation plan for the Node/PostgreSQL adapters and Render blueprint. That plan must reuse the adapter contract suites created here and treat any required core change as evidence of a portability leak.
