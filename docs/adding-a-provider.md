# Replacing the demo provider / adding a provider

This starter ships a **deterministic, fictional** demo provider
(`examples/demo-connector`) so the reference end-to-end test
(`tests/e2e/demo-extension.test.ts`) has something concrete to exercise. It
is sample code, not a product — replace it with your real integration.

## What the demo provider does

`examples/demo-connector/src/demo-provider.ts` implements the `core`
`ProviderConnector` interface (`packages/core/src/provider.ts`):

```ts
export interface ProviderConnector {
  validateCredentials(
    credentials: Uint8Array,
  ): Promise<{ providerAccountReference: string }>;

  handleEvent(input: {
    event: ThrottleEvent;
    idempotencyKey: string; // stable across retries — dedupe on this
    credentials: Uint8Array;
    configuration: unknown;
  }): Promise<void>;
}
```

The demo behavior is entirely deterministic and keyed off the credential
bytes and the installation's saved configuration, which makes it useful both
as a worked example and as a way to exercise every failure path in tests
without a real external dependency:

- **Valid credential**: exactly the UTF-8 bytes `demo-valid`. Anything else
  fails `validateCredentials`/`handleEvent` with a `TerminalProviderError`
  (this is what backs "expired credential" scenarios in tests — configure
  `mode: 'expired'`, see below, or simply use the wrong credential value).
- **`configuration.mode`** (set via `PUT /api/connector/config`) selects a
  failure mode for `handleEvent`:
  - `'429'`, `'500'`, `'timeout'` → throws `RetryableProviderError` (drives
    the retry/backoff tests).
  - `'expired'`, `'malformed'` → throws `TerminalProviderError`.
  - `'pagination'` with `configuration.pages` (1–100) → calls the injected
    `behavior.onPage(page)` hook once per page before succeeding, so tests
    can assert pagination was walked correctly.
  - Anything else (including `{}`) → succeeds.
- For an `order.created` event, on success it calls
  `sink.recordOrderCreated(orderId, idempotencyKey)` **at most once per
  idempotency key** — the in-memory `completedKeys` set is exactly the kind
  of "dedupe by idempotency key" behavior your real provider integration
  must also implement, since `processConnectorEvent` may call `handleEvent`
  again for the same event on infrastructure-level retries.

## Replacing it with your integration

### Option 1: `pnpm setup` (recommended for a new product repository)

```bash
pnpm setup -- --name "Your Connector Name" --slug your-connector-slug --remove-demo
```

`--remove-demo` (see `scripts/setup.mjs` / `scripts/lib/template-files.mjs`)
replaces `examples/demo-connector/src/demo-provider.ts`,
`demo-provider.test.ts`, and `index.ts` with a minimal, type-checked
skeleton that throws `TerminalProviderError` from both methods with `TODO`
markers, and deletes `tests/e2e/demo-extension.test.ts` (which is written
specifically against the demo provider's deterministic behavior and would
otherwise fail once you change what `handleEvent` does). Omit
`--remove-demo` (or pass `--keep-demo`) if you want to keep studying the
demo provider and its lifecycle test while you build your real one
alongside it — see [testing.md](testing.md) for how to adapt or replace
that reference test.

### Option 2: hand-edit

1. Implement `ProviderConnector` in
   `examples/demo-connector/src/demo-provider.ts` (or move/rename the
   package if you'd rather it not live under `examples/`) against your real
   provider's API.
2. Make `handleEvent` idempotent per the `idempotencyKey` it's given — most
   provider APIs support an idempotency key or "external reference ID" field
   for exactly this purpose; use it.
3. Classify every failure your provider can produce as retryable or
   terminal by throwing `RetryableProviderError` or `TerminalProviderError`
   from `@starter/core` (see
   [architecture.md](architecture.md#webhook--queue--provider) for how those
   propagate into the retry/backoff policy). Do not throw a bare `Error` —
   `processConnectorEvent` treats anything else as `UNEXPECTED_ERROR` and
   fails the job terminally without a retry.
4. Update or delete `tests/e2e/demo-extension.test.ts` to match your
   provider's real behavior (see [testing.md](testing.md)).
5. Delete `examples/demo-connector` from `apps/cloudflare`'s dependency
   graph once you're not using it, or replace its contents entirely and keep
   the package name if you prefer.

## Adding new event types and scopes

New Throttle event types flow through the same `ThrottleEvent` contract
(`packages/contracts/src/events.ts` — `id`, `type`, `workspaceId`,
`environmentId`, `createdAt`, and a JSON `data` payload). To add a new event
type:

1. Register the event and any new scopes your extension needs in the
   Throttle dashboard — see
   [Throttle's Events guide](https://docs.usethrottle.dev/developers/extensions/events)
   and [Scopes guide](https://docs.usethrottle.dev/developers/extensions/scopes).
2. Branch on `event.type` inside your provider's `handleEvent` (see the
   demo provider's `if (event.type === 'order.created')` check) and read
   whatever fields you need from `event.data` — validate their shape
   yourself; `data` is only guaranteed to be safe, prototype-pollution-free
   JSON, not shaped to your event.
3. Add a fixture under `tests/fixtures/throttle-events/` and a lifecycle
   test following the pattern in
   [testing.md](testing.md#end-to-end-lifecycle-test).

## Evolving the configuration schema

Per-installation configuration is a single JSON blob validated by
`validateConfigurationValue` (`packages/contracts/src/configuration.ts`),
bounded by `MAX_CONFIGURATION_DEPTH` and `MAX_CONFIGURATION_NODES` and
rejecting prototype-pollution-prone keys (`__proto__`, `prototype`,
`constructor`). It is intentionally an open JSON value rather than a fixed
schema, so you are free to shape it however your provider needs
(`{ "mode": "...", "pages": 3 }` in the demo, but yours might be API region,
sync direction, field mappings, etc.) — just validate the specific fields
your provider reads before trusting them, the way the demo provider does for
`mode` and `pages`.

## Implementing a new runtime adapter

If you need a runtime other than Cloudflare Workers/D1/Queues (for example,
ahead of the Node/PostgreSQL/Render milestone landing upstream — see the
[README roadmap](../README.md#node-postgresql-and-render-roadmap-milestone-2)),
implement the `core` ports (`packages/core/src/ports.ts`:
`InstallationStore`, `CredentialStore`, `ConfigurationStore`,
`ActivityStore`, `JobExecutionStore`, `DeliveryStore`, `Logger`, `Clock`)
against your target datastore, and reuse `packages/core`'s
`connectProvider`/`processConnectorEvent`/retry policy and
`packages/contracts`'s schemas unchanged — that's exactly the boundary they
were designed to sit behind (see
[architecture.md](architecture.md#package-layout-and-why-the-boundary-matters)).
Validate a new persistence adapter against the shared contract test suite in
`packages/core/src/contract-tests.ts` (`runPersistenceAdapterContract`) the
same way `packages/adapters-d1` does, so tenant isolation, idempotency, and
uninstall-atomicity are proven for the new adapter too.
