import type { Installation } from '@starter/contracts';
import { AuthorizationError, ValidationError } from './errors.js';
import type { ProviderConnector } from './provider.js';
import type {
  ActivityStore,
  Clock,
  InstallationScope,
  InstallationStore,
  Logger,
  ProviderConnectionStore,
} from './ports.js';

export interface ConnectProviderDependencies {
  installations: InstallationStore;
  connections: ProviderConnectionStore;
  activities: ActivityStore;
  connector: ProviderConnector;
  clock: Clock;
  logger: Logger;
}
export interface ConnectProviderInput {
  installationId: string;
  scope: InstallationScope;
  credentials: Uint8Array;
}

export async function connectProvider(
  input: ConnectProviderInput,
  dependencies: ConnectProviderDependencies,
): Promise<Installation> {
  const installation = await dependencies.installations.get(
    input.installationId,
    input.scope,
  );
  if (installation?.status !== 'active') throw new AuthorizationError();
  const validationCredentials = new Uint8Array(input.credentials);
  let storageCredentials: Uint8Array | undefined;
  try {
    const validated = await dependencies.connector.validateCredentials(
      validationCredentials,
    );
    if (
      typeof validated.providerAccountReference !== 'string' ||
      validated.providerAccountReference.length === 0
    )
      throw new ValidationError();
    storageCredentials = new Uint8Array(input.credentials);
    const connectedAt = dependencies.clock.now();
    const updated = await dependencies.connections.commit({
      installationId: input.installationId,
      scope: input.scope,
      credentials: storageCredentials,
      providerAccountReference: validated.providerAccountReference,
      now: connectedAt,
    });
    await dependencies.activities.append({
      activityId: `connect:${input.installationId}:${connectedAt.toISOString()}`,
      installationId: input.installationId,
      type: 'connector_sync',
      status: 'completed',
      result: 'success',
      attempt: 0,
      code: 'PROVIDER_CONNECTED',
      createdAt: connectedAt.toISOString(),
    });
    dependencies.logger.info('Provider connected', {
      installationId: input.installationId,
      providerAccountReference: validated.providerAccountReference,
    });
    return updated;
  } finally {
    validationCredentials.fill(0);
    storageCredentials?.fill(0);
  }
}
