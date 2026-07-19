import type { Activity, ConnectorJob, Installation } from '@starter/contracts';
import {
  ConfigurationError,
  InfrastructureError,
  RetryableProviderError,
  TerminalProviderError,
  toActivityErrorCode,
  type AppError,
} from './errors.js';
import type { ProviderConnector } from './provider.js';
import type {
  ActivityStore,
  Clock,
  ConfigurationStore,
  CredentialStore,
  InstallationStore,
  Logger,
} from './ports.js';
import { MAX_JOB_ATTEMPTS, retryDelaySeconds } from './retry.js';

export type ProcessConnectorEventResult =
  | { status: 'success' }
  | { status: 'retry'; delaySeconds: number; code: string }
  | { status: 'terminal'; code: string };
export interface ProcessConnectorEventDependencies {
  installations: InstallationStore;
  credentials: CredentialStore;
  configurations: ConfigurationStore;
  activities: ActivityStore;
  connector: ProviderConnector;
  clock: Clock;
  logger: Logger;
}
function scopeCode(
  installation: Installation | undefined,
  job: ConnectorJob,
): string | undefined {
  if (!installation) return 'INSTALLATION_NOT_FOUND';
  if (installation.status !== 'active') return 'INSTALLATION_INACTIVE';
  if (
    installation.workspaceId !== job.event.workspaceId ||
    installation.environmentId !== job.event.environmentId
  )
    return 'INSTALLATION_SCOPE_MISMATCH';
  return undefined;
}
function makeActivity(
  job: ConnectorJob,
  at: Date,
  result: Activity['result'],
  code?: string,
): Activity {
  return {
    activityId: `${job.jobId}:${job.attempt}`,
    installationId: job.installationId,
    eventId: job.event.id,
    jobId: job.jobId,
    type: 'connector_sync',
    status: 'completed',
    result,
    attempt: job.attempt,
    ...(code === undefined ? {} : { code }),
    createdAt: at.toISOString(),
  };
}
async function finish(
  job: ConnectorJob,
  dependencies: ProcessConnectorEventDependencies,
  result: ProcessConnectorEventResult,
): Promise<ProcessConnectorEventResult> {
  const activityResult =
    result.status === 'success'
      ? 'success'
      : result.status === 'retry'
        ? 'retryable_failure'
        : 'terminal_failure';
  await dependencies.activities.append(
    makeActivity(
      job,
      dependencies.clock.now(),
      activityResult,
      result.status === 'success' ? undefined : result.code,
    ),
  );
  return result;
}

/** Processes only jobs accepted by the authenticated internal enqueue path. */
export async function processConnectorEvent(
  job: ConnectorJob,
  dependencies: ProcessConnectorEventDependencies,
): Promise<ProcessConnectorEventResult> {
  const installation = await dependencies.installations.getForJob(
    job.installationId,
  );
  const invalid = scopeCode(installation, job);
  if (invalid)
    return finish(job, dependencies, { status: 'terminal', code: invalid });
  const configuration = await dependencies.configurations.get(
    job.installationId,
  );
  if (configuration === undefined)
    return finish(job, dependencies, {
      status: 'terminal',
      code: 'CONFIGURATION_MISSING',
    });
  const credential = await dependencies.credentials.get(
    job.installationId,
    'providerCredentials',
  );
  if (!credential)
    return finish(job, dependencies, {
      status: 'terminal',
      code: 'CREDENTIAL_MISSING',
    });
  const ownedCredential = new Uint8Array(credential);
  try {
    await dependencies.connector.handleEvent({
      event: job.event,
      credentials: ownedCredential,
      configuration,
    });
    dependencies.logger.info('Connector event processed', {
      installationId: job.installationId,
      eventId: job.event.id,
      jobId: job.jobId,
      attempt: job.attempt,
    });
    return finish(job, dependencies, { status: 'success' });
  } catch (cause) {
    let error: AppError;
    if (
      cause instanceof RetryableProviderError ||
      cause instanceof TerminalProviderError ||
      cause instanceof ConfigurationError
    )
      error = cause;
    else error = new InfrastructureError({ cause });
    const code = toActivityErrorCode(error);
    dependencies.logger.warn('Connector event failed', {
      installationId: job.installationId,
      eventId: job.event.id,
      jobId: job.jobId,
      attempt: job.attempt,
      code,
    });
    if (error.classification === 'retryable' && job.attempt < MAX_JOB_ATTEMPTS)
      return finish(job, dependencies, {
        status: 'retry',
        delaySeconds: retryDelaySeconds(Math.max(1, job.attempt)),
        code,
      });
    return finish(job, dependencies, {
      status: 'terminal',
      code: error.classification === 'retryable' ? 'ATTEMPTS_EXHAUSTED' : code,
    });
  } finally {
    ownedCredential.fill(0);
  }
}
