import type { Installation } from '@starter/contracts';
import { AuthorizationError, ValidationError } from './errors.js';
import type { ProviderConnector } from './provider.js';
import type {
  ActivityStore,
  Clock,
  CredentialStore,
  InstallationScope,
  InstallationStore,
  Logger,
} from './ports.js';

export interface ConnectProviderDependencies {
  installations: InstallationStore;
  credentials: CredentialStore;
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
  const ownedCredentials = new Uint8Array(input.credentials);
  try {
    const validated =
      await dependencies.connector.validateCredentials(ownedCredentials);
    if (
      typeof validated.providerAccountReference !== 'string' ||
      validated.providerAccountReference.length === 0
    )
      throw new ValidationError();
    await dependencies.credentials.set(
      input.installationId,
      'providerCredentials',
      ownedCredentials,
    );
    const connectedAt = dependencies.clock.now();
    const updated =
      await dependencies.installations.updateProviderAccountReference(
        input.installationId,
        input.scope,
        validated.providerAccountReference,
        connectedAt,
      );
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
    ownedCredentials.fill(0);
  }
}
