import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { ConnectorJob, Installation } from '@starter/contracts';
import {
  D1ConfigurationStore,
  D1InstallationBootstrapStore,
  D1WebhookAcceptanceStore,
  type D1Database,
} from './index.js';

let runtime: Miniflare;
let database: D1Database;
async function applyMigration(migration: string) {
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
const keyring = {
  current: () => ({ version: 1, key: new Uint8Array(32).fill(9) }),
  resolve: (version: number) =>
    version === 1 ? new Uint8Array(32).fill(9) : undefined,
};
const installation: Installation = {
  installationId: 'task9-install',
  workspaceId: 'task9-workspace',
  applicationId: 'task9-app',
  environmentId: 'task9-env',
  environmentKind: 'non_production',
  extensionVersion: '1',
  status: 'active',
  createdAt: '2026-07-19T10:00:00.000Z',
  updatedAt: '2026-07-19T10:00:00.000Z',
};
const job: ConnectorJob = {
  jobId: JSON.stringify(['task9-install', 'event-1']),
  installationId: 'task9-install',
  event: {
    id: 'event-1',
    type: 'order.created',
    workspaceId: 'task9-workspace',
    environmentId: 'task9-env',
    createdAt: '2026-07-19T10:00:00.000Z',
    data: { orderId: 'order-1' },
  },
  createdAt: '2026-07-19T10:00:00.000Z',
};

beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: `task9-${crypto.randomUUID()}` },
  });
  database = (await runtime.getD1Database('DB')) as D1Database;
  const initialMigration = await readFile(
    new URL('../migrations/0001_initial.sql', import.meta.url),
    'utf8',
  );
  const configurationMigration = await readFile(
    new URL('../migrations/0002_configurations.sql', import.meta.url),
    'utf8',
  );
  await applyMigration(initialMigration);
  await applyMigration(configurationMigration);
});
afterAll(async () => runtime.dispose());

test('bootstrap atomically creates installation and both encrypted secrets', async () => {
  const store = new D1InstallationBootstrapStore(database, keyring);
  await store.commit({
    installation,
    throttleApiKey: new TextEncoder().encode('api-key'),
    webhookSigningSecret: new TextEncoder().encode('signing-secret'),
    replace: false,
    actorId: 'user-1',
  });
  const rows = await database
    .prepare(
      'SELECT kind, ciphertext FROM secrets WHERE installation_id=? ORDER BY kind',
    )
    .bind(installation.installationId)
    .all<{ kind: string; ciphertext: string }>();
  expect(rows.results.map((row) => row.kind)).toEqual([
    'throttleApiKey',
    'webhookSigningSecret',
  ]);
  expect(JSON.stringify(rows.results)).not.toContain('api-key');
  expect(
    await new D1ConfigurationStore(database).get(installation.installationId),
  ).toBeNull();
  await expect(
    store.commit({
      installation,
      throttleApiKey: new TextEncoder().encode('new-api'),
      webhookSigningSecret: new TextEncoder().encode('new-hook'),
      replace: false,
      actorId: 'user-1',
    }),
  ).rejects.toMatchObject({ reason: 'replace_required' });
});

test('bootstrap rolls back a new installation when a secret write fails', async () => {
  const store = new D1InstallationBootstrapStore(database, keyring);
  await database
    .prepare(
      "CREATE TRIGGER task9_force_failure BEFORE INSERT ON secrets WHEN NEW.installation_id='rollback-install' AND NEW.kind='webhookSigningSecret' BEGIN SELECT RAISE(ABORT,'forced'); END",
    )
    .run();
  try {
    await expect(
      store.commit({
        installation: { ...installation, installationId: 'rollback-install' },
        throttleApiKey: new TextEncoder().encode('api'),
        webhookSigningSecret: new TextEncoder().encode('hook'),
        replace: false,
        actorId: 'user-1',
      }),
    ).rejects.toThrow();
  } finally {
    await database.prepare('DROP TRIGGER task9_force_failure').run();
  }
  expect(
    await database
      .prepare(
        'SELECT installation_id FROM installations WHERE installation_id=?',
      )
      .bind('rollback-install')
      .first(),
  ).toBeNull();
});

test('rotation rejects unknown, uninstalled, and cross-tenant targets', async () => {
  const store = new D1InstallationBootstrapStore(database, keyring);
  const inputSecrets = {
    throttleApiKey: new TextEncoder().encode('api'),
    webhookSigningSecret: new TextEncoder().encode('hook'),
    replace: true,
    actorId: 'user-1',
  };
  await expect(
    store.commit({
      ...inputSecrets,
      installation: { ...installation, installationId: 'unknown-install' },
    }),
  ).rejects.toMatchObject({ reason: 'target_not_found' });
  await expect(
    store.commit({
      ...inputSecrets,
      installation: { ...installation, workspaceId: 'other-workspace' },
    }),
  ).rejects.toMatchObject({ reason: 'scope_conflict' });
  await database
    .prepare(
      "UPDATE installations SET status='uninstalled',uninstalled_at=?,updated_at=? WHERE installation_id=?",
    )
    .bind(
      '2026-07-19T11:00:00.000Z',
      '2026-07-19T11:00:00.000Z',
      installation.installationId,
    )
    .run();
  await expect(
    store.commit({ ...inputSecrets, installation }),
  ).rejects.toMatchObject({ reason: 'scope_conflict' });
  await database
    .prepare(
      "UPDATE installations SET status='active',uninstalled_at=NULL,updated_at=? WHERE installation_id=?",
    )
    .bind(installation.updatedAt, installation.installationId)
    .run();
});

test('atomically persists a deterministic accepted job and makes duplicate retry safe', async () => {
  const store = new D1WebhookAcceptanceStore(database);
  expect(await store.accept(job)).toEqual({ accepted: true });
  expect(await store.accept(job)).toEqual({ accepted: false });
  expect(
    await database
      .prepare('SELECT count(*) AS count FROM jobs WHERE job_id=?')
      .bind(job.jobId)
      .first<{ count: number }>(),
  ).toEqual({ count: 1 });
  expect(
    await database
      .prepare('SELECT count(*) AS count FROM activities WHERE job_id=?')
      .bind(job.jobId)
      .first<{ count: number }>(),
  ).toEqual({ count: 1 });
});

test('configuration is bounded safe JSON and retained only while installed', async () => {
  const store = new D1ConfigurationStore(database);
  await store.set(installation.installationId, {
    mode: 'pagination',
    pages: 3,
  });
  expect(await store.get(installation.installationId)).toEqual({
    mode: 'pagination',
    pages: 3,
  });
  await expect(
    store.set(
      installation.installationId,
      JSON.parse('{"__proto__":true}') as never,
    ),
  ).rejects.toThrow();
  await expect(
    store.set(installation.installationId, 'x'.repeat(33 * 1024)),
  ).rejects.toThrow();
});
