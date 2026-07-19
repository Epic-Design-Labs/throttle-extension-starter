import {
  validateConfigurationValue,
  type ConfigurationValue,
} from '@starter/contracts';
import type { ConfigurationStore } from '@starter/core';
import type { D1Database } from './database.js';
import { requireText } from './database.js';

const MAX_CONFIGURATION_BYTES = 32 * 1024;
function serialize(value: unknown): string {
  if (!validateConfigurationValue(value))
    throw new Error('Configuration must be safe JSON');
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > MAX_CONFIGURATION_BYTES)
    throw new Error('Configuration exceeds maximum size');
  return text;
}

export class D1ConfigurationStore implements ConfigurationStore {
  constructor(private readonly db: D1Database) {}
  async get(installationId: string): Promise<ConfigurationValue | undefined> {
    const row = await this.db
      .prepare(
        'SELECT configuration_json FROM configurations WHERE installation_id=?',
      )
      .bind(requireText(installationId, 'installationId'))
      .first<{ configuration_json: string }>();
    if (row === null) return undefined;
    const value: unknown = JSON.parse(row.configuration_json);
    if (!validateConfigurationValue(value))
      throw new Error('Stored configuration is invalid');
    return value;
  }
  async set(
    installationId: string,
    configuration: ConfigurationValue,
  ): Promise<void> {
    const result = await this.db
      .prepare(
        "INSERT INTO configurations (installation_id,configuration_json,updated_at) SELECT installation_id,?,? FROM installations WHERE installation_id=? AND status='active' ON CONFLICT(installation_id) DO UPDATE SET configuration_json=excluded.configuration_json,updated_at=excluded.updated_at",
      )
      .bind(
        serialize(configuration),
        new Date().toISOString(),
        requireText(installationId, 'installationId'),
      )
      .run();
    if (result.meta.changes !== 1)
      throw new Error('Active installation not found');
  }
}
