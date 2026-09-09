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
  ThrottleControlPlane,
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
  /**
   * Optional: without it, `extension.webhook_secret_rotated` is logged and
   * dropped — the endpoint keeps verifying until the grace window closes and
   * then rejects every delivery until someone updates the stored secret.
   */
  throttle?: ThrottleControlPlane;
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
  attempt: number,
  at: Date,
  result: Activity['result'],
  code?: string,
): Activity {
  return {
    activityId: `${job.jobId}:${attempt}`,
    installationId: job.installationId,
    eventId: job.event.id,
    jobId: job.jobId,
    type: 'connector_sync',
    status: 'completed',
    result,
    attempt,
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
  attempt: number,
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
  const now = dependencies.clock.now();
  const execution = await dependencies.executions.finish({
    jobId: job.jobId,
    attempt,
    token,
    status:
      result.status === 'success'
        ? 'completed'
        : result.status === 'retry'
          ? 'retry'
          : 'failed',
    ...(result.status === 'retry'
      ? {
          nextEligibleAt: new Date(now.valueOf() + result.delaySeconds * 1000),
        }
      : {}),
    activity: makeActivity(
      job,
      attempt,
      now,
      activityResult,
      result.status === 'success' ? undefined : result.code,
    ),
    now,
  });
  if (execution === 'cancelled')
    return { status: 'terminal', code: 'JOB_CANCELLED' };
  if (execution === 'stale') return { status: 'terminal', code: 'JOB_STALE' };
  return result;
}

async function handleUninstalled(
  job: ConnectorJob,
  installation: Installation,
  dependencies: ProcessConnectorEventDependencies,
): Promise<ProcessConnectorEventResult> {
  // Match on the id in the payload, not on the envelope: a workspace can hold
  // several installations of the same extension, one per application.
  if (
    job.event.data['installationId'] !== job.installationId ||
    installation.workspaceId !== job.event.workspaceId ||
    installation.environmentId !== job.event.environmentId
  )
    return { status: 'terminal', code: 'INSTALLATION_SCOPE_MISMATCH' };
  const reported = new Date(String(job.event.data['uninstalledAt'] ?? ''));
  await dependencies.installations.markUninstalled(
    job.installationId,
    {
      workspaceId: installation.workspaceId,
      applicationId: installation.applicationId,
      environmentId: installation.environmentId,
    },
    Number.isNaN(reported.valueOf()) ? dependencies.clock.now() : reported,
  );
  dependencies.logger.info('Installation uninstalled by Throttle', {
    installationId: job.installationId,
    eventId: job.event.id,
    jobId: job.jobId,
    reason: String(job.event.data['reason'] ?? 'unknown'),
  });
  return { status: 'success' };
}

/**
 * Throttle rotated this installation's webhook signing secret and is telling
 * us — the event is signed with BOTH the outgoing and the new secret, which is
 * why it verified with the one we still hold. Fetch the new secret with the
 * installation's own API key and store it before `previousSecretExpiresAt`.
 * The event never carries the secret itself.
 */
async function handleWebhookSecretRotated(
  job: ConnectorJob,
  installation: Installation,
  attempt: number,
  dependencies: ProcessConnectorEventDependencies,
): Promise<ProcessConnectorEventResult> {
  if (
    job.event.data['installationId'] !== job.installationId ||
    installation.workspaceId !== job.event.workspaceId ||
    installation.environmentId !== job.event.environmentId
  )
    return { status: 'terminal', code: 'INSTALLATION_SCOPE_MISMATCH' };
  if (!dependencies.throttle) {
    dependencies.logger.warn(
      'Webhook secret rotated but no Throttle control plane is configured; stored secret NOT refreshed',
      { installationId: job.installationId, eventId: job.event.id },
    );
    return { status: 'terminal', code: 'SECRET_REFRESH_UNAVAILABLE' };
  }
  const apiKey = await dependencies.credentials.get(
    job.installationId,
    'throttleApiKey',
  );
  if (!apiKey) return { status: 'terminal', code: 'CREDENTIAL_MISSING' };
  let secret: Uint8Array | undefined;
  try {
    secret = await dependencies.throttle.fetchWebhookSigningSecret({
      installationId: job.installationId,
      apiKey,
    });
  } catch (cause) {
    dependencies.logger.warn('Webhook secret refresh failed; will retry', {
      installationId: job.installationId,
      eventId: job.event.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    if (attempt < MAX_JOB_ATTEMPTS)
      return {
        status: 'retry',
        code: 'SECRET_REFRESH_FAILED',
        delaySeconds: retryDelaySeconds(attempt),
      };
    return { status: 'terminal', code: 'ATTEMPTS_EXHAUSTED' };
  } finally {
    apiKey.fill(0);
  }
  if (!secret) return { status: 'terminal', code: 'SECRET_UNAVAILABLE' };
  try {
    await dependencies.credentials.set(
      job.installationId,
      'webhookSigningSecret',
      secret,
    );
  } finally {
    secret.fill(0);
  }
  dependencies.logger.info('Webhook signing secret refreshed after rotation', {
    installationId: job.installationId,
    eventId: job.event.id,
    previousSecretExpiresAt: String(
      job.event.data['previousSecretExpiresAt'] ?? 'revoked',
    ),
  });
  return { status: 'success' };
}

/** Processes only jobs accepted by the authenticated internal enqueue path. */
export async function processConnectorEvent(
  job: ConnectorJob,
  dependencies: ProcessConnectorEventDependencies,
): Promise<ProcessConnectorEventResult> {
  const claim = await dependencies.executions.claim({
    jobId: job.jobId,
    now: dependencies.clock.now(),
  });
  if (claim.status === 'duplicate') return { status: 'success' };
  if (claim.status === 'busy')
    return {
      status: 'retry',
      code: 'JOB_BUSY',
      delaySeconds: claim.retryAfterSeconds,
    };
  if (claim.status === 'unavailable')
    return { status: 'terminal', code: 'JOB_UNAVAILABLE' };
  const attempt = claim.attempt;
  if (attempt > MAX_JOB_ATTEMPTS)
    return finish(job, attempt, dependencies, claim.token, {
      status: 'terminal',
      code: 'ATTEMPTS_EXHAUSTED',
    });
  // Throttle's signed reachability probe: sent after every platform deploy
  // and every six hours, verified like any delivery (it reached here, so the
  // signature matched). Nothing to process; answering success is the point.
  if (job.event.type === 'extension.ping')
    return finish(job, attempt, dependencies, claim.token, {
      status: 'success',
    });
  const installation = await dependencies.installations.getForJob(
    job.installationId,
  );
  if (installation && job.event.type === 'extension.webhook_secret_rotated')
    return finish(
      job,
      attempt,
      dependencies,
      claim.token,
      await handleWebhookSecretRotated(
        job,
        installation,
        attempt,
        dependencies,
      ),
    );
  // Throttle's signal that this installation is over, sent after the platform
  // row already reads `uninstalled` and aimed at this installation's own
  // endpoint. Handled ahead of the active/configuration/credential gates on
  // purpose: a pending or disconnected install must still be cleaned up, and
  // the point is to delete the credential, not to need one.
  if (installation && job.event.type === 'extension.uninstalled')
    return finish(
      job,
      attempt,
      dependencies,
      claim.token,
      await handleUninstalled(job, installation, dependencies),
    );
  const invalid = scopeCode(installation, job);
  if (invalid)
    return finish(job, attempt, dependencies, claim.token, {
      status: 'terminal',
      code: invalid,
    });
  const configuration = await dependencies.configurations.get(
    job.installationId,
  );
  if (configuration === undefined)
    return finish(job, attempt, dependencies, claim.token, {
      status: 'terminal',
      code: 'CONFIGURATION_MISSING',
    });
  const credential = await dependencies.credentials.get(
    job.installationId,
    'providerCredentials',
  );
  if (!credential)
    return finish(job, attempt, dependencies, claim.token, {
      status: 'terminal',
      code: 'CREDENTIAL_MISSING',
    });
  try {
    await dependencies.connector.handleEvent({
      event: job.event,
      installationId: job.installationId,
      idempotencyKey: connectorIdempotencyKey(job.installationId, job.event.id),
      credentials: credential,
      configuration,
    });
    dependencies.logger.info('Connector event processed', {
      installationId: job.installationId,
      eventId: job.event.id,
      jobId: job.jobId,
      attempt,
    });
    return finish(job, attempt, dependencies, claim.token, {
      status: 'success',
    });
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
        attempt,
        code: 'UNEXPECTED_ERROR',
      });
      return finish(job, attempt, dependencies, claim.token, {
        status: 'terminal',
        code: 'UNEXPECTED_ERROR',
      });
    }
    const code = toActivityErrorCode(error);
    dependencies.logger.warn('Connector event failed', {
      installationId: job.installationId,
      eventId: job.event.id,
      jobId: job.jobId,
      attempt,
      code,
    });
    if (error.classification === 'retryable' && attempt < MAX_JOB_ATTEMPTS)
      return finish(job, attempt, dependencies, claim.token, {
        status: 'retry',
        delaySeconds: retryDelaySeconds(
          attempt,
          error instanceof RetryableProviderError
            ? error.retryAfterSeconds
            : undefined,
        ),
        code,
      });
    return finish(job, attempt, dependencies, claim.token, {
      status: 'terminal',
      code: error.classification === 'retryable' ? 'ATTEMPTS_EXHAUSTED' : code,
    });
  } finally {
    credential.fill(0);
  }
}
