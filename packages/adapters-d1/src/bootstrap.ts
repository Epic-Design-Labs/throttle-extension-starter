import { installationSchema, type Installation } from '@starter/contracts';
import { encryptSecret } from '@starter/security';
import type { CredentialKeyring } from './credentials.js';
import type { D1Database } from './database.js';

type Existing = {
  installation_id: string;
  workspace_id: string;
  application_id: string;
  environment_id: string;
  status: string;
  created_at: string;
};

export class InstallationBootstrapError extends Error {
  constructor(
    readonly reason: 'replace_required' | 'target_not_found' | 'scope_conflict',
  ) {
    super('Installation bootstrap conflict');
  }
}

export class D1InstallationBootstrapStore {
  constructor(
    private readonly db: D1Database,
    private readonly keyring: CredentialKeyring,
  ) {}

  async commit(input: {
    installation: Installation;
    throttleApiKey: Uint8Array;
    webhookSigningSecret: Uint8Array;
    replace: boolean;
    actorId: string;
  }): Promise<Installation> {
    const item = installationSchema.parse(input.installation);
    if (item.status !== 'active')
      throw new Error('Bootstrap installation must be active');
    const existing = await this.db
      .prepare(
        'SELECT installation_id,workspace_id,application_id,environment_id,status,created_at FROM installations WHERE installation_id=?',
      )
      .bind(item.installationId)
      .first<Existing>();
    if (existing !== null) {
      if (!input.replace)
        throw new InstallationBootstrapError('replace_required');
      if (
        existing.status !== 'active' ||
        existing.workspace_id !== item.workspaceId ||
        existing.application_id !== item.applicationId ||
        existing.environment_id !== item.environmentId
      )
        throw new InstallationBootstrapError('scope_conflict');
    } else if (input.replace) {
      throw new InstallationBootstrapError('target_not_found');
    }
    const apiKey = new Uint8Array(input.throttleApiKey);
    const signingSecret = new Uint8Array(input.webhookSigningSecret);
    try {
      if (apiKey.byteLength < 1 || signingSecret.byteLength < 1)
        throw new Error('Secrets must be non-empty');
      const current = this.keyring.current();
      const [apiEnvelope, signingEnvelope] = await Promise.all([
        encryptSecret(
          apiKey,
          current.key,
          item.installationId,
          current.version,
        ),
        encryptSecret(
          signingSecret,
          current.key,
          item.installationId,
          current.version,
        ),
      ]);
      const at = item.updatedAt;
      const installStatement =
        existing === null
          ? this.db
              .prepare(
                "INSERT INTO installations (installation_id,workspace_id,application_id,environment_id,environment_kind,extension_version,provider_account_reference,status,last_successful_sync_cursor,created_at,updated_at,uninstalled_at) VALUES (?,?,?,?,?,?,NULL,'active',NULL,?,?,NULL)",
              )
              .bind(
                item.installationId,
                item.workspaceId,
                item.applicationId,
                item.environmentId,
                item.environmentKind,
                item.extensionVersion,
                item.createdAt,
                item.updatedAt,
              )
          : this.db
              .prepare(
                "UPDATE installations SET environment_kind=?,extension_version=?,updated_at=? WHERE installation_id=? AND workspace_id=? AND application_id=? AND environment_id=? AND status='active'",
              )
              .bind(
                item.environmentKind,
                item.extensionVersion,
                at,
                item.installationId,
                item.workspaceId,
                item.applicationId,
                item.environmentId,
              );
      const secretStatement = (
        kind: 'throttleApiKey' | 'webhookSigningSecret',
        envelope: typeof apiEnvelope,
      ) =>
        this.db
          .prepare(
            'INSERT INTO secrets (installation_id,kind,algorithm,key_version,iv,ciphertext,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(installation_id,kind) DO UPDATE SET algorithm=excluded.algorithm,key_version=excluded.key_version,iv=excluded.iv,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at',
          )
          .bind(
            item.installationId,
            kind,
            envelope.algorithm,
            envelope.keyVersion,
            envelope.iv,
            envelope.ciphertext,
            at,
            at,
          );
      const results = await this.db.batch([
        installStatement,
        secretStatement('throttleApiKey', apiEnvelope),
        secretStatement('webhookSigningSecret', signingEnvelope),
        this.db
          .prepare(
            "INSERT OR IGNORE INTO configurations (installation_id,configuration_json,updated_at) VALUES (?,'null',?)",
          )
          .bind(item.installationId, at),
        this.db
          .prepare(
            "INSERT OR IGNORE INTO activities (activity_id,installation_id,event_id,job_id,type,status,result,attempt,message,code,created_at) VALUES (?, ?, NULL, NULL, 'connector_sync', 'completed', 'success', 0, NULL, ?, ?)",
          )
          .bind(
            JSON.stringify([
              input.replace ? 'secrets_rotated' : 'installation_bootstrapped',
              item.installationId,
              at,
            ]),
            item.installationId,
            input.replace ? 'SECRETS_ROTATED' : 'INSTALLATION_BOOTSTRAPPED',
            at,
          ),
      ]);
      if (results.slice(0, 3).some((result) => result.meta.changes !== 1))
        throw new Error('Bootstrap transaction did not persist every record');
      return { ...item, createdAt: existing?.created_at ?? item.createdAt };
    } finally {
      apiKey.fill(0);
      signingSecret.fill(0);
    }
  }
}
