import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import type {
  Activity,
  ThrottleEvent,
} from '../../packages/contracts/src/index.js';
import {
  createD1Adapters,
  InstallationBootstrapError,
  type D1Database,
} from '../../packages/adapters-d1/src/index.js';
import {
  consumeConnectorQueue,
  createActivityStoreQueueFailureRecorder,
  createCloudflareQueueProducer,
  type CloudflareQueue,
  type CloudflareQueueMessage,
  type ConnectorQueuePayload,
} from '../../packages/adapters-cloudflare-queue/src/index.js';
import {
  connectProvider,
  processConnectorEvent,
  type Logger,
} from '../../packages/core/src/index.js';
import { createDemoProvider } from '../../examples/demo-connector/src/index.js';
import { createExtensionIdentityVerifier } from '../../packages/throttle/src/index.js';
import { createApp } from '../../apps/cloudflare/src/app.js';
import { mapBootstrapError } from '../../apps/cloudflare/src/composition/index.js';
import { signWebhook } from './sign-webhook.js';

const EXTENSION_ID = 'extension-demo';
const INSTALLATION_ID = 'installation-demo';
const WEBHOOK_SECRET = 'test-webhook-secret';
const DASHBOARD_ORIGIN = 'https://dashboard.usethrottle.dev';
const encoder = new TextEncoder();

type IdentityOverrides = { installationId?: string };
type JobRow = { status: string; attempt: number };
type QueueItem = {
  id: string;
  body: ConnectorQueuePayload;
  attempts: number;
  readyAt: number;
};

class TestClock {
  constructor(private value = new Date('2026-07-19T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.value);
  }
  advanceSeconds(seconds: number): void {
    this.value = new Date(this.value.valueOf() + seconds * 1000);
  }
}

class InProcessQueue implements CloudflareQueue {
  private readonly items = new Map<string, QueueItem>();
  private sequence = 0;

  constructor(private readonly clock: TestClock) {}

  async send(body: ConnectorQueuePayload): Promise<void> {
    const id = `message-${String(++this.sequence)}`;
    this.items.set(id, {
      id,
      body: structuredClone(body),
      attempts: 1,
      readyAt: this.clock.now().valueOf(),
    });
  }

  count(): number {
    return this.items.size;
  }

  async drain(
    consume: (message: CloudflareQueueMessage) => Promise<void>,
  ): Promise<void> {
    const readyIds = [...this.items.values()]
      .filter((item) => item.readyAt <= this.clock.now().valueOf())
      .map((item) => item.id);
    for (const id of readyIds) {
      const item = this.items.get(id);
      if (!item) continue;
      let settled = false;
      await consume({
        id: item.id,
        body: structuredClone(item.body),
        attempts: item.attempts,
        ack: () => {
          if (settled) throw new Error('Queue message settled twice');
          settled = true;
          this.items.delete(id);
        },
        retry: ({ delaySeconds }) => {
          if (settled) throw new Error('Queue message settled twice');
          settled = true;
          item.attempts += 1;
          item.readyAt = this.clock.now().valueOf() + delaySeconds * 1000;
        },
      });
      if (!settled) throw new Error('Queue message was not settled');
    }
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

async function createIdentity(clock: TestClock) {
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const header = base64url(
    encoder.encode(
      JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }),
    ),
  );
  return {
    verifier: createExtensionIdentityVerifier({
      extensionId: EXTENSION_ID,
      jwks: {
        keys: [{ ...publicJwk, alg: 'RS256', kid: 'test-key', use: 'sig' }],
      },
      currentDate: () => clock.now(),
    }),
    async issue(overrides: IdentityOverrides = {}): Promise<string> {
      const installationId = overrides.installationId ?? INSTALLATION_ID;
      const now = Math.floor(clock.now().valueOf() / 1000);
      const payload = base64url(
        encoder.encode(
          JSON.stringify({
            iss: 'throttle',
            sub: installationId,
            aud: EXTENSION_ID,
            iat: now,
            nbf: now - 1,
            exp: now + 600,
            extensionId: EXTENSION_ID,
            version: '0.1.0',
            installationId,
            workspace: { id: 'workspace-demo', slug: 'workspace-demo' },
            application: { id: 'application-demo', slug: 'application-demo' },
            environment: {
              environmentId: 'environment-demo',
              environmentSlug: 'environment-demo',
              environmentKind: 'non_production',
              providerEnvironment: 'sandbox',
            },
            role: 'admin',
            scopes: ['connector:read', 'connector:write'],
            user: { id: 'user-demo', email: 'dev@example.test' },
          }),
        ),
      );
      const unsigned = `${header}.${payload}`;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keys.privateKey,
        encoder.encode(unsigned),
      );
      return `${unsigned}.${base64url(new Uint8Array(signature))}`;
    },
  };
}

async function applyMigrations(database: D1Database): Promise<void> {
  for (const relative of [
    '../../packages/adapters-d1/migrations/0001_initial.sql',
    '../../packages/adapters-d1/migrations/0002_configurations.sql',
  ]) {
    const migration = await readFile(
      new URL(relative, import.meta.url),
      'utf8',
    );
    const statements: string[] = [];
    let pending = '';
    let trigger = false;
    for (const line of migration.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!pending) trigger = trimmed.startsWith('CREATE TRIGGER');
      pending += `${trimmed}\n`;
      if (
        (!trigger && trimmed.endsWith(';')) ||
        (trigger && trimmed.endsWith('END;'))
      ) {
        statements.push(pending.trim());
        pending = '';
        trigger = false;
      }
    }
    for (const statement of statements) await database.prepare(statement).run();
  }
}

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface TestSystem {
  bootstrap(): Promise<Response>;
  connect(): Promise<Response>;
  configure(value: unknown): Promise<Response>;
  deliver(
    event: ThrottleEvent,
    options?: { signatureSecret?: string },
  ): Promise<Response>;
  fetch(
    path: string,
    init?: RequestInit,
    identity?: IdentityOverrides,
  ): Promise<Response>;
  readActivities(response: Response): Promise<Activity[]>;
  activitiesFromApi(): Promise<Activity[]>;
  drainReadyQueue(): Promise<void>;
  advanceSeconds(seconds: number): void;
  queuedCount(): number;
  jobCount(): Promise<number>;
  jobState(eventId: string): Promise<JobRow | null>;
  providerOrders(): string[];
  dispose(): Promise<void>;
}

export async function createTestSystem(): Promise<TestSystem> {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: `e2e-${crypto.randomUUID()}` },
  });
  const database = (await runtime.getD1Database('DB')) as D1Database;
  await applyMigrations(database);
  const clock = new TestClock();
  const identity = await createIdentity(clock);
  const queue = new InProcessQueue(clock);
  const key = new Uint8Array(32).fill(23);
  const adapters = createD1Adapters({
    database,
    credentialKeys: {
      current: () => ({ version: 1, key }),
      resolve: (version) => (version === 1 ? key : undefined),
    },
    idGenerator: { next: () => crypto.randomUUID() },
  });
  const orders: string[] = [];
  const connector = createDemoProvider({
    sink: {
      async recordOrderCreated(orderId) {
        orders.push(orderId);
      },
    },
  });
  const queueProducer = createCloudflareQueueProducer(queue);
  const app = createApp({
    dashboardOrigin: DASHBOARD_ORIGIN,
    authorizationScopes: {
      read: 'connector:read',
      mutation: 'connector:write',
    },
    clock,
    encodeProviderCredentials: (value) => encoder.encode(value),
    createRequestId: () => crypto.randomUUID(),
    identityVerifier: identity.verifier,
    readiness: async () => true,
    installations: adapters.installations,
    credentials: adapters.credentials,
    bootstrap: async ({
      identity: verified,
      throttleApiKey,
      webhookSigningSecret,
      replace,
    }) => {
      const at = clock.now().toISOString();
      try {
        return await adapters.bootstrap.commit({
          installation: {
            installationId: verified.installationId,
            workspaceId: verified.workspaceId,
            applicationId: verified.applicationId,
            environmentId: verified.environmentId,
            environmentKind: verified.environmentKind,
            extensionVersion: verified.version,
            status: 'active',
            createdAt: at,
            updatedAt: at,
          },
          throttleApiKey,
          webhookSigningSecret,
          replace,
          actorId: verified.userId,
        });
      } catch (error) {
        if (!(error instanceof InstallationBootstrapError)) throw error;
        throw mapBootstrapError(error);
      }
    },
    acceptJob: (job) => adapters.webhookAcceptance.accept(job),
    queue: queueProducer,
    connect: ({ identity: verified, credentials }) =>
      connectProvider(
        {
          installationId: verified.installationId,
          scope: {
            workspaceId: verified.workspaceId,
            applicationId: verified.applicationId,
            environmentId: verified.environmentId,
          },
          credentials,
        },
        {
          installations: adapters.installations,
          connections: adapters.connections,
          activities: adapters.activities,
          connector,
          clock,
          logger,
        },
      ),
    activities: adapters.activities,
    configurations: adapters.configurations,
    uninstall: ({ identity: verified }) =>
      adapters.installations.markUninstalled(
        verified.installationId,
        {
          workspaceId: verified.workspaceId,
          applicationId: verified.applicationId,
          environmentId: verified.environmentId,
        },
        clock.now(),
      ),
    logger,
  });
  const consumeOne = (message: CloudflareQueueMessage) =>
    consumeConnectorQueue(
      { messages: [message] },
      {
        processConnectorEvent: (job) =>
          processConnectorEvent(job, {
            installations: adapters.installations,
            credentials: adapters.credentials,
            configurations: adapters.configurations,
            activities: adapters.activities,
            executions: adapters.executions,
            connector,
            clock,
            logger,
          }),
        logger,
        recordFailure: createActivityStoreQueueFailureRecorder({
          activities: adapters.activities,
          clock,
        }),
        maxDeliveryAttempts: 5,
      },
    );

  async function fetch(
    path: string,
    init: RequestInit = {},
    overrides: IdentityOverrides = {},
  ): Promise<Response> {
    const token = await identity.issue(overrides);
    return app.request(`https://worker.example${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
  }

  async function readActivities(response: Response): Promise<Activity[]> {
    const body = (await response.json()) as { activities: Activity[] };
    return body.activities;
  }

  return {
    bootstrap: () =>
      fetch('/api/installation/secrets', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          throttleApiKey: 'test-throttle-api-key',
          webhookSigningSecret: WEBHOOK_SECRET,
          replace: false,
        }),
      }),
    connect: () =>
      fetch('/api/connector/credentials', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ credentials: 'demo-valid' }),
      }),
    configure: (value) =>
      fetch('/api/connector/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      }),
    async deliver(event, options = {}) {
      const rawBody = JSON.stringify(event);
      const timestamp = Math.floor(clock.now().valueOf() / 1000);
      return app.request('https://worker.example/webhooks/throttle', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-throttle-event-id': event.id,
          'x-throttle-event-type': event.type,
          'x-throttle-signature': await signWebhook({
            rawBody,
            secret: options.signatureSecret ?? WEBHOOK_SECRET,
            timestamp,
          }),
        },
        body: rawBody,
      });
    },
    fetch,
    readActivities,
    async activitiesFromApi() {
      const response = await fetch('/api/activity');
      if (!response.ok) throw new Error('Activity endpoint request failed');
      return readActivities(response);
    },
    drainReadyQueue: () => queue.drain(consumeOne),
    advanceSeconds: (seconds) => clock.advanceSeconds(seconds),
    queuedCount: () => queue.count(),
    async jobCount() {
      const row = await database
        .prepare('SELECT count(*) AS count FROM jobs')
        .first<{ count: number }>();
      return row?.count ?? 0;
    },
    jobState: (eventId) =>
      database
        .prepare('SELECT status,attempt FROM jobs WHERE job_id=?')
        .bind(JSON.stringify([INSTALLATION_ID, eventId]))
        .first<JobRow>(),
    providerOrders: () => [...orders],
    async dispose() {
      key.fill(0);
      await runtime.dispose();
    },
  };
}
