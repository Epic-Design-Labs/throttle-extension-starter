import { D1ActivityStore } from './activities.js';
import { D1CredentialStore } from './credentials.js';
import { D1DeliveryStore } from './deliveries.js';
import { D1InstallationStore } from './installations.js';
import type { D1Database } from './database.js';

export type { D1Database, D1PreparedStatement, D1Result } from './database.js';
export { D1ActivityStore } from './activities.js';
export { D1CredentialStore } from './credentials.js';
export { D1DeliveryStore } from './deliveries.js';
export {
  D1InstallationStore,
  MAX_WEBHOOK_VERIFICATION_CANDIDATES,
} from './installations.js';

export function createD1Adapters(input: {
  database: D1Database;
  rootKey: Uint8Array;
  keyVersion?: number;
}) {
  const keyVersion = input.keyVersion ?? 1;
  return {
    installations: new D1InstallationStore(input.database),
    credentials: new D1CredentialStore(
      input.database,
      input.rootKey,
      keyVersion,
    ),
    deliveries: new D1DeliveryStore(input.database),
    activities: new D1ActivityStore(input.database),
  };
}
