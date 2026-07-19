import { installationSchema, type Installation } from '@starter/contracts';
import {
  MAX_WEBHOOK_VERIFICATION_CANDIDATES,
  type InstallationStore,
} from '@starter/core';
import type { D1Database } from './database.js';
import { requireText } from './database.js';

export { MAX_WEBHOOK_VERIFICATION_CANDIDATES };

type Row = Record<string, unknown>;
const map = (row: Row): Installation =>
  installationSchema.parse({
    installationId: row.installation_id,
    workspaceId: row.workspace_id,
    applicationId: row.application_id,
    environmentId: row.environment_id,
    environmentKind: row.environment_kind,
    extensionVersion: row.extension_version,
    ...(row.provider_account_reference == null
      ? {}
      : { providerAccountReference: row.provider_account_reference }),
    status: row.status,
    ...(row.last_successful_sync_cursor == null
      ? {}
      : { lastSuccessfulSyncCursor: row.last_successful_sync_cursor }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.uninstalled_at == null
      ? {}
      : { uninstalledAt: row.uninstalled_at }),
  });

const columns =
  'installation_id, workspace_id, application_id, environment_id, environment_kind, extension_version, provider_account_reference, status, last_successful_sync_cursor, created_at, updated_at, uninstalled_at';

export class D1InstallationStore implements InstallationStore {
  constructor(private readonly db: D1Database) {}
  async get(installationId: string): Promise<Installation | undefined> {
    const row = await this.db
      .prepare(`SELECT ${columns} FROM installations WHERE installation_id = ?`)
      .bind(requireText(installationId, 'installationId'))
      .first<Row>();
    return row === null ? undefined : map(row);
  }
  async upsert(value: Installation): Promise<Installation> {
    const item = installationSchema.parse(value);
    await this.db
      .prepare(
        `INSERT INTO installations (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id) DO UPDATE SET workspace_id=excluded.workspace_id, application_id=excluded.application_id, environment_id=excluded.environment_id, environment_kind=excluded.environment_kind, extension_version=excluded.extension_version, provider_account_reference=excluded.provider_account_reference, status=excluded.status, last_successful_sync_cursor=excluded.last_successful_sync_cursor, created_at=excluded.created_at, updated_at=excluded.updated_at, uninstalled_at=excluded.uninstalled_at`,
      )
      .bind(
        item.installationId,
        item.workspaceId,
        item.applicationId,
        item.environmentId,
        item.environmentKind,
        item.extensionVersion,
        item.providerAccountReference ?? null,
        item.status,
        item.lastSuccessfulSyncCursor ?? null,
        item.createdAt,
        item.updatedAt,
        item.uninstalledAt ?? null,
      )
      .run();
    return (await this.get(item.installationId))!;
  }
  async findWebhookVerificationCandidates(input: {
    workspaceId: string;
    environmentId: string;
  }): Promise<Installation[]> {
    const result = await this.db
      .prepare(
        `SELECT ${columns} FROM installations WHERE workspace_id = ? AND environment_id = ? AND status != 'uninstalled' ORDER BY installation_id LIMIT ?`,
      )
      .bind(
        requireText(input.workspaceId, 'workspaceId'),
        requireText(input.environmentId, 'environmentId'),
        MAX_WEBHOOK_VERIFICATION_CANDIDATES,
      )
      .all<Row>();
    return result.results.map(map);
  }
  /** D1 batch executes these statements as one transaction and rolls all back on failure. */
  async markUninstalled(
    installationId: string,
    uninstalledAt: Date,
  ): Promise<void> {
    requireText(installationId, 'installationId');
    if (
      !(uninstalledAt instanceof Date) ||
      Number.isNaN(uninstalledAt.valueOf())
    )
      throw new Error('uninstalledAt must be a valid Date');
    const timestamp = uninstalledAt.toISOString();
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE installations SET status='uninstalled', updated_at=CASE WHEN status='uninstalled' THEN updated_at ELSE ? END, uninstalled_at=CASE WHEN status='uninstalled' THEN uninstalled_at ELSE ? END WHERE installation_id = ?`,
        )
        .bind(timestamp, timestamp, installationId),
      this.db
        .prepare('DELETE FROM secrets WHERE installation_id = ?')
        .bind(installationId),
      this.db
        .prepare(
          `UPDATE jobs SET status='cancelled', updated_at=? WHERE installation_id=? AND status IN ('pending','retry')`,
        )
        .bind(timestamp, installationId),
    ]);
  }
}
