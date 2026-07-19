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
  JobExecutionStore,
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
  executions: JobExecutionStore;
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
/** JSON tuple encoding is stable and cannot collide when IDs contain delimiters. */
export function connectorIdempotencyKey(
  installationId: string,
  eventId: string,
): string {
  return JSON.stringify([installationId, eventId]);
}
async function finish(
  job: ConnectorJob,
  dependencies: ProcessConnectorEventDependencies,
  token: string,
  result: ProcessConnectorEventResult,
): Promise<ProcessConnectorEventResult> {
  const activityResult =
    result.status === 'success'
      ? 'success'
      : result.status === 'retry'
        ? 'retryable_failure'
        : 'terminal_failure';
  const execution = await dependencies.executions.finish({
    jobId: job.jobId,
    attempt: job.attempt,
    token,
    status:
      result.status === 'success'
        ? 'completed'
        : result.status === 'retry'
          ? 'retry'
          : 'failed',
    activity: makeActivity(
      job,
      dependencies.clock.now(),
      activityResult,
      result.status === 'success' ? undefined : result.code,
    ),
    now: dependencies.clock.now(),
  });
  if (execution === 'cancelled')
    return { status: 'terminal', code: 'JOB_CANCELLED' };
  if (execution === 'stale') return { status: 'terminal', code: 'JOB_STALE' };
  return result;
}

/** Processes only jobs accepted by the authenticated internal enqueue path. */
export async function processConnectorEvent(
  job: ConnectorJob,
  dependencies: ProcessConnectorEventDependencies,
): Promise<ProcessConnectorEventResult> {
  if (job.attempt > MAX_JOB_ATTEMPTS) {
    const result = { status: 'terminal' as const, code: 'ATTEMPTS_EXHAUSTED' };
    await dependencies.activities.append(
      makeActivity(
        job,
        dependencies.clock.now(),
        'terminal_failure',
        result.code,
      ),
    );
    return result;
  }
  const claim = await dependencies.executions.claim({
    jobId: job.jobId,
    attempt: job.attempt,
    now: dependencies.clock.now(),
  });
  if (claim.status === 'duplicate') return { status: 'success' };
  if (claim.status === 'unavailable')
    return { status: 'terminal', code: 'JOB_UNAVAILABLE' };
  const installation = await dependencies.installations.getForJob(
    job.installationId,
  );
  const invalid = scopeCode(installation, job);
  if (invalid)
    return finish(job, dependencies, claim.token, {
      status: 'terminal',
      code: invalid,
    });
  const configuration = await dependencies.configurations.get(
    job.installationId,
  );
  if (configuration === undefined)
    return finish(job, dependencies, claim.token, {
      status: 'terminal',
      code: 'CONFIGURATION_MISSING',
    });
  const credential = await dependencies.credentials.get(
    job.installationId,
    'providerCredentials',
  );
  if (!credential)
    return finish(job, dependencies, claim.token, {
      status: 'terminal',
      code: 'CREDENTIAL_MISSING',
    });
  try {
    await dependencies.connector.handleEvent({
      event: job.event,
      idempotencyKey: connectorIdempotencyKey(job.installationId, job.event.id),
      credentials: credential,
      configuration,
    });
    dependencies.logger.info('Connector event processed', {
      installationId: job.installationId,
      eventId: job.event.id,
      jobId: job.jobId,
      attempt: job.attempt,
    });
    return finish(job, dependencies, claim.token, { status: 'success' });
  } catch (cause) {
    let error: AppError | undefined;
    if (
      cause instanceof RetryableProviderError ||
      cause instanceof TerminalProviderError ||
      cause instanceof ConfigurationError
    )
      error = cause;
    else if (cause instanceof InfrastructureError) error = cause;
    else {
      dependencies.logger.error('Unexpected connector error', {
        installationId: job.installationId,
        eventId: job.event.id,
        jobId: job.jobId,
        attempt: job.attempt,
        code: 'UNEXPECTED_ERROR',
      });
      return finish(job, dependencies, claim.token, {
        status: 'terminal',
        code: 'UNEXPECTED_ERROR',
      });
    }
    const code = toActivityErrorCode(error);
    dependencies.logger.warn('Connector event failed', {
      installationId: job.installationId,
      eventId: job.event.id,
      jobId: job.jobId,
      attempt: job.attempt,
      code,
    });
    if (error.classification === 'retryable' && job.attempt < MAX_JOB_ATTEMPTS)
      return finish(job, dependencies, claim.token, {
        status: 'retry',
        delaySeconds: retryDelaySeconds(job.attempt),
        code,
      });
    return finish(job, dependencies, claim.token, {
      status: 'terminal',
      code: error.classification === 'retryable' ? 'ATTEMPTS_EXHAUSTED' : code,
    });
  } finally {
    credential.fill(0);
  }
}
