import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import {
  activitySchema,
  type Activity,
  type ThrottleEvent,
} from '../../packages/contracts/src/index.js';
import type {
  D1Database,
  D1PreparedStatement,
} from '../../packages/adapters-d1/src/index.js';
import type {
  CloudflareQueue,
  CloudflareQueueMessage,
  ConnectorQueuePayload,
} from '../../packages/adapters-cloudflare-queue/src/index.js';
import type { ProviderConnector } from '../../packages/core/src/index.js';
import { createDemoProvider } from '../../examples/demo-connector/src/index.js';
import { createExtensionIdentityVerifier } from '../../packages/throttle/src/index.js';
import {
  composeWorker,
  type WorkerCompositionOverrides,
} from '../../apps/cloudflare/src/composition/index.js';
import type { Env } from '../../apps/cloudflare/src/env.js';
import { signWebhook } from './sign-webhook.js';

const EXTENSION_ID = 'extension-demo';
const INSTALLATION_ID = 'installation-demo';
const WEBHOOK_SECRET = 'test-webhook-secret';
const DASHBOARD_ORIGIN = 'https://dashboard.usethrottle.dev';
const encoder = new TextEncoder();

type IdentityOverrides = { installationId?: string };
type JobRow = { status: string; attempt: number; scheduledAt: string };
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
    const readyKeys = [...this.items.entries()]
      .filter(([, item]) => item.readyAt <= this.clock.now().valueOf())
      .map(([key]) => key);
    for (const key of readyKeys) {
      const item = this.items.get(key);
      if (!item) continue;
      let settled = false;
      await consume({
        id: item.id,
        body: structuredClone(item.body),
        attempts: item.attempts,
        ack: () => {
          if (settled) throw new Error('Queue message settled twice');
          settled = true;
          this.items.delete(key);
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
    '../../packages/adapters-d1/migrations/0003_queue_dispatch.sql',
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

function mapActivity(row: Record<string, unknown>): Activity {
  return activitySchema.parse({
    activityId: row.activity_id,
    installationId: row.installation_id,
    ...(row.event_id == null ? {} : { eventId: row.event_id }),
    ...(row.job_id == null ? {} : { jobId: row.job_id }),
    type: row.type,
    status: row.status,
    result: row.result,
    attempt: row.attempt,
    ...(row.message == null ? {} : { message: row.message }),
    ...(row.code == null ? {} : { code: row.code }),
    createdAt: row.created_at,
  });
}

function failFirstQueuePublishMark(database: D1Database): D1Database {
  let fail = true;
  return {
    prepare(query) {
      const statement = database.prepare(query);
      if (!/^UPDATE jobs SET queue_published_at=/u.test(query))
        return statement;
      let bound = statement;
      const intercepted: D1PreparedStatement = {
        bind(...values) {
          bound = bound.bind(...values);
          return intercepted;
        },
        first: <T>() => bound.first<T>(),
        all: <T>() => bound.all<T>(),
        async run<T>() {
          if (fail) {
            fail = false;
            throw new Error('Injected queue publish mark failure');
          }
          return bound.run<T>();
        },
      };
      return intercepted;
    },
    batch: (statements) => database.batch(statements),
    exec: (query) => database.exec(query),
  };
}

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
  eventActivities(eventId: string): Promise<Activity[]>;
  connectorActivityCount(eventId: string): Promise<number>;
  drainReadyQueue(): Promise<void>;
  advanceSeconds(seconds: number): void;
  nowPlusSeconds(seconds: number): string;
  queuedCount(): number;
  providerAttemptCount(): number;
  jobCount(): Promise<number>;
  jobState(eventId: string): Promise<JobRow | null>;
  providerOrders(): string[];
  dispose(): Promise<void>;
}

export async function createTestSystem(
  options: { failFirstQueuePublishMark?: boolean } = {},
): Promise<TestSystem> {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: `e2e-${crypto.randomUUID()}` },
  });
  const database = (await runtime.getD1Database('DB')) as D1Database;
  await applyMigrations(database);
  const workerDatabase = options.failFirstQueuePublishMark
    ? failFirstQueuePublishMark(database)
    : database;
  const clock = new TestClock();
  const identity = await createIdentity(clock);
  const queueBinding = new InProcessQueue(clock);
  const orders: string[] = [];
  let providerAttempts = 0;
  const demo = createDemoProvider({
    sink: {
      async recordOrderCreated(orderId) {
        orders.push(orderId);
      },
    },
  });
  const connector: ProviderConnector = {
    validateCredentials: (credentials) => demo.validateCredentials(credentials),
    async handleEvent(input) {
      providerAttempts += 1;
      return demo.handleEvent(input);
    },
  };
  const key = new Uint8Array(32).fill(23);
  const env: Env = {
    DB: workerDatabase,
    CONNECTOR_QUEUE: queueBinding,
    ENCRYPTION_KEY: base64url(key),
    ENCRYPTION_KEY_VERSION: '1',
    ENCRYPTION_KEYRING: '{}',
    THROTTLE_DASHBOARD_ORIGIN: DASHBOARD_ORIGIN,
    THROTTLE_JWKS_URL: 'https://identity.example/jwks.json',
    THROTTLE_EXTENSION_ID: EXTENSION_ID,
    THROTTLE_READ_SCOPE: 'connector:read',
    THROTTLE_MUTATION_SCOPE: 'connector:write',
    QUEUE_MAX_ATTEMPTS: '5',
  };
  const overrides: WorkerCompositionOverrides = {
    clock,
    connector,
    identityVerifier: identity.verifier,
  };
  const worker = composeWorker(env, overrides);
  const consumeOne = (message: CloudflareQueueMessage) =>
    worker.queue({ messages: [message] });

  async function fetch(
    path: string,
    init: RequestInit = {},
    overrides: IdentityOverrides = {},
  ): Promise<Response> {
    const token = await identity.issue(overrides);
    return worker.app.request(`https://worker.example${path}`, {
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

  async function eventActivities(eventId: string): Promise<Activity[]> {
    const rows = await database
      .prepare(
        'SELECT activity_id,installation_id,event_id,job_id,type,status,result,attempt,message,code,created_at FROM activities WHERE event_id=? ORDER BY attempt,activity_id',
      )
      .bind(eventId)
      .all<Record<string, unknown>>();
    return rows.results.map(mapActivity);
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
      return worker.app.request('https://worker.example/webhooks/throttle', {
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
    eventActivities,
    async connectorActivityCount(eventId) {
      return (await eventActivities(eventId)).filter(
        (activity) => activity.type === 'connector_sync',
      ).length;
    },
    drainReadyQueue: () => queueBinding.drain(consumeOne),
    advanceSeconds: (seconds) => clock.advanceSeconds(seconds),
    nowPlusSeconds: (seconds) =>
      new Date(clock.now().valueOf() + seconds * 1000).toISOString(),
    queuedCount: () => queueBinding.count(),
    providerAttemptCount: () => providerAttempts,
    async jobCount() {
      const row = await database
        .prepare('SELECT count(*) AS count FROM jobs')
        .first<{ count: number }>();
      return row?.count ?? 0;
    },
    async jobState(eventId) {
      const row = await database
        .prepare('SELECT status,attempt,scheduled_at FROM jobs WHERE job_id=?')
        .bind(JSON.stringify([INSTALLATION_ID, eventId]))
        .first<{ status: string; attempt: number; scheduled_at: string }>();
      return row === null
        ? null
        : {
            status: row.status,
            attempt: row.attempt,
            scheduledAt: row.scheduled_at,
          };
    },
    providerOrders: () => [...orders],
    async dispose() {
      key.fill(0);
      await runtime.dispose();
    },
  };
}
