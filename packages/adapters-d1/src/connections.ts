import { installationSchema, type Installation } from '@starter/contracts';
import type { InstallationScope, ProviderConnectionStore } from '@starter/core';
import { encryptSecret } from '@starter/security';
import type { CredentialKeyring } from './credentials.js';
import type { D1Database } from './database.js';
import { requireText } from './database.js';

export class D1ProviderConnectionStore implements ProviderConnectionStore {
  constructor(
    private readonly db: D1Database,
    private readonly keyring: CredentialKeyring,
  ) {}
  async commit(input: {
    installationId: string;
    scope: InstallationScope;
    credentials: Uint8Array;
    providerAccountReference: string;
    now: Date;
  }): Promise<Installation> {
    const owned = new Uint8Array(input.credentials);
    try {
      const current = this.keyring.current();
      const envelope = await encryptSecret(
        owned,
        current.key,
        input.installationId,
        current.version,
      );
      const at = input.now.toISOString();
      const results = await this.db.batch([
        this.db
          .prepare(
            "UPDATE installations SET provider_account_reference=?, updated_at=? WHERE installation_id=? AND workspace_id=? AND application_id=? AND environment_id=? AND status='active'",
          )
          .bind(
            requireText(
              input.providerAccountReference,
              'providerAccountReference',
            ),
            at,
            requireText(input.installationId, 'installationId'),
            input.scope.workspaceId,
            input.scope.applicationId,
            input.scope.environmentId,
          ),
        this.db
          .prepare(
            "INSERT INTO secrets (installation_id,kind,algorithm,key_version,iv,ciphertext,created_at,updated_at) SELECT installation_id,'providerCredentials',?,?,?,?,?,? FROM installations WHERE installation_id=? AND workspace_id=? AND application_id=? AND environment_id=? AND status='active' ON CONFLICT(installation_id,kind) DO UPDATE SET algorithm=excluded.algorithm,key_version=excluded.key_version,iv=excluded.iv,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at",
          )
          .bind(
            envelope.algorithm,
            envelope.keyVersion,
            envelope.iv,
            envelope.ciphertext,
            at,
            at,
            input.installationId,
            input.scope.workspaceId,
            input.scope.applicationId,
            input.scope.environmentId,
          ),
      ]);
      if (results.some((result) => result.meta.changes !== 1))
        throw new Error('Active scoped installation not found');
      const row = await this.db
        .prepare(
          'SELECT installation_id,workspace_id,application_id,environment_id,environment_kind,extension_version,provider_account_reference,status,last_successful_sync_cursor,created_at,updated_at,uninstalled_at FROM installations WHERE installation_id=?',
        )
        .bind(input.installationId)
        .first<Record<string, unknown>>();
      return installationSchema.parse({
        installationId: row?.installation_id,
        workspaceId: row?.workspace_id,
        applicationId: row?.application_id,
        environmentId: row?.environment_id,
        environmentKind: row?.environment_kind,
        extensionVersion: row?.extension_version,
        providerAccountReference: row?.provider_account_reference,
        status: row?.status,
        ...(row?.last_successful_sync_cursor == null
          ? {}
          : { lastSuccessfulSyncCursor: row.last_successful_sync_cursor }),
        createdAt: row?.created_at,
        updatedAt: row?.updated_at,
        ...(row?.uninstalled_at == null
          ? {}
          : { uninstalledAt: row.uninstalled_at }),
      });
    } finally {
      owned.fill(0);
    }
  }
}
