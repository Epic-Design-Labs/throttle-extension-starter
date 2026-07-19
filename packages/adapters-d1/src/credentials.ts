import type { CredentialKind, CredentialStore } from '@starter/core';
import { decryptSecret, encryptSecret } from '@starter/security';
import type { D1Database } from './database.js';
import { requireText } from './database.js';

const kinds = new Set<CredentialKind>([
  'throttleApiKey',
  'webhookSigningSecret',
  'providerCredentials',
]);
const validateKind = (kind: CredentialKind): CredentialKind => {
  if (!kinds.has(kind)) throw new Error('Unsupported credential kind');
  return kind;
};

interface SecretRow {
  algorithm: unknown;
  key_version: unknown;
  iv: unknown;
  ciphertext: unknown;
}

export interface CredentialKeyring {
  /** Keys remain caller-owned; the adapter and security layer copy key bytes before use. */
  current(): { version: number; key: Uint8Array };
  resolve(version: number): Uint8Array | undefined;
}

export class D1CredentialStore implements CredentialStore {
  constructor(
    private readonly db: D1Database,
    private readonly keyring: CredentialKeyring,
  ) {}
  async get(
    installationId: string,
    kind: CredentialKind,
  ): Promise<Uint8Array | undefined> {
    const id = requireText(installationId, 'installationId');
    const row = await this.db
      .prepare(
        'SELECT algorithm, key_version, iv, ciphertext FROM secrets WHERE installation_id = ? AND kind = ?',
      )
      .bind(id, validateKind(kind))
      .first<SecretRow>();
    if (row === null) return undefined;
    const key = this.keyring.resolve(row.key_version as number);
    if (key === undefined) throw new Error('Unable to decrypt secret');
    return decryptSecret(
      {
        algorithm: row.algorithm,
        keyVersion: row.key_version,
        iv: row.iv,
        ciphertext: row.ciphertext,
      },
      key,
      id,
    );
  }
  async set(
    installationId: string,
    kind: CredentialKind,
    credentials: Uint8Array,
  ): Promise<void> {
    const id = requireText(installationId, 'installationId');
    validateKind(kind);
    const owned = new Uint8Array(credentials);
    try {
      const current = this.keyring.current();
      const envelope = await encryptSecret(
        owned,
        current.key,
        id,
        current.version,
      );
      const now = new Date().toISOString();
      try {
        await this.db
          .prepare(
            `INSERT INTO secrets (installation_id, kind, algorithm, key_version, iv, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(installation_id, kind) DO UPDATE SET algorithm=excluded.algorithm, key_version=excluded.key_version, iv=excluded.iv, ciphertext=excluded.ciphertext, updated_at=excluded.updated_at`,
          )
          .bind(
            id,
            kind,
            envelope.algorithm,
            envelope.keyVersion,
            envelope.iv,
            envelope.ciphertext,
            now,
            now,
          )
          .run();
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('installation is uninstalled')
        )
          throw new Error(
            'Credential write blocked for uninstalled installation',
            { cause: error },
          );
        throw error;
      }
    } finally {
      owned.fill(0);
    }
  }
  async delete(installationId: string, kind?: CredentialKind): Promise<void> {
    const id = requireText(installationId, 'installationId');
    if (kind === undefined)
      await this.db
        .prepare('DELETE FROM secrets WHERE installation_id = ?')
        .bind(id)
        .run();
    else
      await this.db
        .prepare('DELETE FROM secrets WHERE installation_id = ? AND kind = ?')
        .bind(id, validateKind(kind))
        .run();
  }
}
