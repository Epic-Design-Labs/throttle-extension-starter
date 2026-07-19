import type { ConnectorJob, Installation } from '@starter/contracts';
import type {
  ActivityStore,
  ConfigurationStore,
  CredentialKind,
  Logger,
  WebhookCandidateLookupResult,
} from '@starter/core';
import type {
  ExtensionIdentityVerifier,
  VerifiedExtensionIdentity,
} from '@starter/throttle';
import { Hono } from 'hono';
import type { Variables } from './middleware/auth.js';
import { parseBearer } from './middleware/auth.js';
import {
  authenticationFailed,
  forbidden,
  toHttpError,
} from './middleware/errors.js';
import { registerConnectorRoutes } from './routes/connector.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

export type AppBindings = { Variables: Variables };
type Scope = {
  workspaceId: string;
  applicationId: string;
  environmentId: string;
};
export interface AppDependencies {
  dashboardOrigin: string;
  authorizationScopes: { read: string; mutation: string };
  clock: { now(): Date };
  encodeProviderCredentials(value: string): Uint8Array;
  createRequestId(): string;
  identityVerifier: ExtensionIdentityVerifier;
  readiness(): Promise<boolean>;
  installations: {
    get(id: string, scope: Scope): Promise<Installation | undefined>;
    findWebhookVerificationCandidates(input: {
      workspaceId: string;
      environmentId: string;
    }): Promise<WebhookCandidateLookupResult>;
  };
  credentials: {
    get(id: string, kind: CredentialKind): Promise<Uint8Array | undefined>;
  };
  bootstrap(input: {
    identity: VerifiedExtensionIdentity;
    throttleApiKey: Uint8Array;
    webhookSigningSecret: Uint8Array;
    replace: boolean;
  }): Promise<Installation>;
  acceptJob(
    job: ConnectorJob,
  ): Promise<{ accepted: boolean; enqueueRequired: boolean }>;
  markJobEnqueued(jobId: string, publishedAt: Date): Promise<void>;
  queue: { enqueue(job: ConnectorJob): Promise<void> };
  connect(input: {
    identity: VerifiedExtensionIdentity;
    credentials: Uint8Array;
  }): Promise<Installation>;
  activities: Pick<ActivityStore, 'list'>;
  configurations: ConfigurationStore;
  uninstall(input: { identity: VerifiedExtensionIdentity }): Promise<void>;
  logger: Logger;
}

export function createApp(dependencies: AppDependencies) {
  const origin = new URL(dependencies.dashboardOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== dependencies.dashboardOrigin
  )
    throw new Error('Dashboard origin must be an exact HTTPS origin');
  if (
    !dependencies.authorizationScopes.read ||
    !dependencies.authorizationScopes.mutation
  )
    throw new Error('Authorization scopes are required');
  const app = new Hono<AppBindings>();
  app.use('*', async (c, next) => {
    const requestId = dependencies.createRequestId();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    c.header(
      'content-security-policy',
      `default-src 'none'; frame-ancestors ${dependencies.dashboardOrigin}`,
    );
    c.header('x-content-type-options', 'nosniff');
    if (c.req.header('origin') === dependencies.dashboardOrigin) {
      c.header('access-control-allow-origin', dependencies.dashboardOrigin);
      c.header('vary', 'Origin');
    }
    await next();
  });
  app.options('/api/*', (c) => {
    if (c.req.header('origin') !== dependencies.dashboardOrigin)
      return c.body(null, 403);
    c.header('access-control-allow-methods', 'GET, PUT, DELETE, OPTIONS');
    c.header('access-control-allow-headers', 'Authorization, Content-Type');
    return c.body(null, 204);
  });
  app.use('/api/*', async (c, next) => {
    let token: string;
    try {
      token = parseBearer(c.req.header('authorization'));
    } catch {
      throw authenticationFailed();
    }
    let verified: VerifiedExtensionIdentity;
    try {
      verified = await dependencies.identityVerifier.verify(token);
    } catch {
      throw authenticationFailed();
    }
    const requiredScope =
      c.req.method === 'GET'
        ? dependencies.authorizationScopes.read
        : dependencies.authorizationScopes.mutation;
    if (!verified.scopes.includes(requiredScope)) throw forbidden();
    c.set('identity', verified);
    await next();
  });
  registerHealthRoutes(app, dependencies);
  registerWebhookRoutes(app, dependencies);
  registerConnectorRoutes(app, dependencies);
  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: 'Resource not found.',
          requestId: c.get('requestId'),
        },
      },
      404,
    ),
  );
  app.onError((error, c) => {
    const safe = toHttpError(error);
    dependencies.logger.error('HTTP request failed', {
      code: safe.code,
      requestId: c.get('requestId'),
    });
    return c.json(
      {
        error: {
          code: safe.code,
          message: safe.message,
          requestId: c.get('requestId'),
        },
      },
      safe.status,
    );
  });
  return app;
}
