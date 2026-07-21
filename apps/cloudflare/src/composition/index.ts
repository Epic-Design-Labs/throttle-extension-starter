import {
  consumeConnectorQueue,
  createActivityStoreQueueFailureRecorder,
  createCloudflareQueueProducer,
  type CloudflareQueueMessageBatch,
  type ConnectorQueueConsumerDependencies,
} from '@starter/adapters-cloudflare-queue';
import {
  createD1Adapters,
  InstallationBootstrapError,
} from '@starter/adapters-d1';
import {
  connectProvider,
  processConnectorEvent,
  type Clock,
  type Logger,
  type ProviderConnector,
} from '@starter/core';
import { createDemoProvider } from '@starter/demo-connector';
import { redact } from '@starter/security';
import {
  createExtensionIdentityVerifier,
  type ExtensionIdentityVerifier,
} from '@starter/throttle';
import { createApp } from '../app.js';
import type { Env } from '../env.js';
import { validateEnv } from '../env.js';
import { HttpError } from '../middleware/errors.js';

const systemClock = { now: () => new Date() };
const verifierCache = new Map<string, ExtensionIdentityVerifier>();
const MAX_VERIFIER_CONFIGURATIONS = 8;

export function getCachedIdentityVerifier(
  config: { extensionId: string; jwksUrl: string },
  factory: (config: {
    extensionId: string;
    jwksUrl: string;
  }) => ExtensionIdentityVerifier = createExtensionIdentityVerifier,
): ExtensionIdentityVerifier {
  const key = JSON.stringify([config.jwksUrl, config.extensionId]);
  const cached = verifierCache.get(key);
  if (cached) return cached;
  if (verifierCache.size >= MAX_VERIFIER_CONFIGURATIONS)
    throw new Error('Too many identity verifier configurations');
  const created = factory(config);
  verifierCache.set(key, created);
  return created;
}

function logger(): Logger {
  const write = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ) => {
    console[level](
      JSON.stringify({
        level,
        message,
        ...(fields ? { fields: redact(fields) } : {}),
      }),
    );
  };
  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}

export function createQueueEntrypoint(
  dependencies: ConnectorQueueConsumerDependencies,
) {
  return (batch: CloudflareQueueMessageBatch) =>
    consumeConnectorQueue(batch, dependencies);
}

export function mapBootstrapError(
  error: InstallationBootstrapError,
): HttpError {
  if (error.reason === 'scope_conflict')
    return new HttpError(
      403,
      'INSTALLATION_SCOPE_CONFLICT',
      'Access is not permitted.',
    );
  return new HttpError(
    409,
    error.reason === 'replace_required'
      ? 'ROTATION_CONFIRMATION_REQUIRED'
      : 'ROTATION_TARGET_NOT_FOUND',
    error.reason === 'replace_required'
      ? 'Secret rotation requires explicit confirmation.'
      : 'The rotation target was not found.',
  );
}

export interface WorkerCompositionOverrides {
  clock?: Clock;
  connector?: ProviderConnector;
  identityVerifier?: ExtensionIdentityVerifier;
}

export function composeWorker(
  rawEnv: Env,
  overrides: WorkerCompositionOverrides = {},
) {
  const env = validateEnv(rawEnv);
  const clock = overrides.clock ?? systemClock;
  const adapters = createD1Adapters({
    database: env.database,
    credentialKeys: env.keyring,
    idGenerator: { next: () => crypto.randomUUID() },
  });
  const connector = overrides.connector ?? createDemoProvider();
  const safeLogger = logger();
  const queueProducer = createCloudflareQueueProducer(env.queue);
  const identityVerifier =
    overrides.identityVerifier ??
    getCachedIdentityVerifier({
      extensionId: env.extensionId,
      jwksUrl: env.jwksUrl,
    });
  const app = createApp({
    dashboardOrigin: env.dashboardOrigin,
    ...(env.uiOrigin === undefined ? {} : { uiOrigin: env.uiOrigin }),
    authorizationScopes: env.authorizationScopes,
    clock,
    encodeProviderCredentials: (value) => new TextEncoder().encode(value),
    createRequestId: () => crypto.randomUUID(),
    identityVerifier,
    readiness: async () => {
      const row = await env.database
        .prepare('SELECT 1 AS ready')
        .first<{ ready: number }>();
      return row?.ready === 1;
    },
    installations: adapters.installations,
    credentials: adapters.credentials,
    bootstrap: async ({
      identity,
      throttleApiKey,
      webhookSigningSecret,
      replace,
    }) => {
      const at = clock.now().toISOString();
      try {
        return await adapters.bootstrap.commit({
          installation: {
            installationId: identity.installationId,
            workspaceId: identity.workspaceId,
            applicationId: identity.applicationId,
            environmentId: identity.environmentId,
            environmentKind: identity.environmentKind,
            extensionVersion: identity.version,
            status: 'active',
            createdAt: at,
            updatedAt: at,
          },
          throttleApiKey,
          webhookSigningSecret,
          replace,
          actorId: identity.userId,
        });
      } catch (error) {
        if (!(error instanceof InstallationBootstrapError)) throw error;
        throw mapBootstrapError(error);
      }
    },
    acceptJob: (job) => adapters.webhookAcceptance.accept(job),
    markJobEnqueued: (jobId, publishedAt) =>
      adapters.webhookAcceptance.markEnqueued(jobId, publishedAt),
    queue: queueProducer,
    connect: ({ identity, credentials }) =>
      connectProvider(
        {
          installationId: identity.installationId,
          scope: {
            workspaceId: identity.workspaceId,
            applicationId: identity.applicationId,
            environmentId: identity.environmentId,
          },
          credentials,
        },
        {
          installations: adapters.installations,
          connections: adapters.connections,
          activities: adapters.activities,
          connector,
          clock,
          logger: safeLogger,
        },
      ),
    activities: adapters.activities,
    configurations: adapters.configurations,
    uninstall: ({ identity }) =>
      adapters.installations.markUninstalled(
        identity.installationId,
        {
          workspaceId: identity.workspaceId,
          applicationId: identity.applicationId,
          environmentId: identity.environmentId,
        },
        clock.now(),
      ),
    logger: safeLogger,
  });
  const queue = createQueueEntrypoint({
    processConnectorEvent: (job) =>
      processConnectorEvent(job, {
        installations: adapters.installations,
        credentials: adapters.credentials,
        configurations: adapters.configurations,
        activities: adapters.activities,
        executions: adapters.executions,
        connector,
        clock,
        logger: safeLogger,
      }),
    logger: safeLogger,
    recordFailure: createActivityStoreQueueFailureRecorder({
      activities: adapters.activities,
      clock,
    }),
    maxDeliveryAttempts: env.queueMaxAttempts,
  });
  return { app, queue };
}
