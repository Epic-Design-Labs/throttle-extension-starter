import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  Activity,
  ConnectorJob,
  Installation,
  ThrottleEvent,
} from '@starter/contracts';
import { activitySchema } from '@starter/contracts';

import {
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  InfrastructureError,
  MAX_JOB_ATTEMPTS,
  RetryableProviderError,
  TerminalProviderError,
  ValidationError,
  classifyProviderFailure,
  retryDelaySeconds,
  toActivityErrorCode,
} from './index.js';
import type {
  ActivityStore,
  AppError,
  Clock,
  CredentialStore,
  DeliveryStore,
  InstallationStore,
  JobQueue,
  Logger,
  ProviderConnector,
} from './index.js';

describe('provider retry policy', () => {
  it.each([429, 500, 502, 503, 504])('retries HTTP %s', (status) => {
    expect(classifyProviderFailure(status)).toBe('retryable');
  });

  it.each([400, 401, 403, 404, 422])(
    'does not blindly retry HTTP %s',
    (status) => {
      expect(classifyProviderFailure(status)).toBe('terminal');
    },
  );

  it.each([0, -1, 99, 600, 200.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsupported HTTP status %s',
    (status) => {
      expect(() => classifyProviderFailure(status)).toThrow(ValidationError);
    },
  );

  it('uses bounded exponential backoff', () => {
    expect([1, 2, 3, 10].map(retryDelaySeconds)).toEqual([5, 25, 125, 900]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid attempt %s',
    (attempt) => {
      expect(() => retryDelaySeconds(attempt)).toThrow(ValidationError);
    },
  );

  it('publishes the attempt bound', () => {
    expect(MAX_JOB_ATTEMPTS).toBe(5);
  });
});

describe('safe core errors', () => {
  const cases = [
    [ValidationError, 'validationError', 'The request is invalid.', 'terminal'],
    [
      AuthenticationError,
      'authenticationError',
      'Authentication failed.',
      'terminal',
    ],
    [
      AuthorizationError,
      'authorizationError',
      'Access is not permitted.',
      'terminal',
    ],
    [
      ConfigurationError,
      'configurationError',
      'Configuration is invalid.',
      'terminal',
    ],
    [
      RetryableProviderError,
      'retryableProviderError',
      'The provider is temporarily unavailable.',
      'retryable',
    ],
    [
      TerminalProviderError,
      'terminalProviderError',
      'The provider rejected the operation.',
      'terminal',
    ],
    [
      InfrastructureError,
      'infrastructureError',
      'A temporary infrastructure failure occurred.',
      'retryable',
    ],
  ] as const;

  it.each(cases)(
    'gives %s a stable public contract',
    (ErrorType, code, message, classification) => {
      const error = new ErrorType();
      expect(error).toMatchObject({ code, message, classification });
    },
  );

  it('never serializes a cause', () => {
    const secret = 'credential-do-not-serialize';
    const error = new InfrastructureError({ cause: new Error(secret) });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error.toJSON()).toEqual({
      code: 'infrastructureError',
      message: 'A temporary infrastructure failure occurred.',
      classification: 'retryable',
    });
  });

  it.each([
    [new ValidationError(), 'VALIDATION_ERROR'],
    [new AuthenticationError(), 'AUTHENTICATION_ERROR'],
    [new AuthorizationError(), 'AUTHORIZATION_ERROR'],
    [new ConfigurationError(), 'CONFIGURATION_ERROR'],
    [new RetryableProviderError(), 'RETRYABLE_PROVIDER_ERROR'],
    [new TerminalProviderError(), 'TERMINAL_PROVIDER_ERROR'],
    [
      new InfrastructureError({
        cause: new Error('credential-do-not-serialize'),
      }),
      'INFRASTRUCTURE_ERROR',
    ],
  ] as const)(
    'maps %s to an activity-safe code',
    (error: AppError, expectedCode) => {
      const code = toActivityErrorCode(error);
      const activity = activitySchema.parse({
        activityId: 'activity_1',
        installationId: 'installation_1',
        type: 'connector_sync',
        status: 'completed',
        result:
          error.classification === 'retryable'
            ? 'retryable_failure'
            : 'terminal_failure',
        attempt: 1,
        code,
        createdAt: '2026-07-19T00:00:00.000Z',
      });

      expect(code).toBe(expectedCode);
      expect(activity.code).toBe(expectedCode);
      expect(code).not.toContain(error.message);
      expect(code).not.toContain('credential-do-not-serialize');
    },
  );
});

describe('portable ports', () => {
  it('compile against in-memory fakes', () => {
    const installationStore: InstallationStore = {
      get: async () => undefined,
      getForJob: async () => undefined,
      upsert: async (installation) => installation,
      markUninstalled: async () => undefined,
      updateProviderAccountReference: async () => {
        throw new Error('not implemented by fake');
      },
      findWebhookVerificationCandidates: async () => ({
        status: 'ok' as const,
        candidates: [],
      }),
    };
    const credentialStore: CredentialStore = {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
    };
    const deliveryStore: DeliveryStore = {
      accept: async () => ({ accepted: true }),
    };
    const jobQueue: JobQueue = { enqueue: async () => undefined };
    const activityStore: ActivityStore = {
      append: async () => undefined,
      list: async () => [],
    };
    const provider: ProviderConnector = {
      validateCredentials: async () => ({
        providerAccountReference: 'account',
      }),
      handleEvent: async () => undefined,
    };
    const clock: Clock = { now: () => new Date(0) };
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };

    expectTypeOf(installationStore.upsert)
      .parameter(0)
      .toEqualTypeOf<Installation>();
    expectTypeOf(jobQueue.enqueue).parameter(0).toEqualTypeOf<ConnectorJob>();
    expectTypeOf(activityStore.append).parameter(0).toEqualTypeOf<Activity>();
    expectTypeOf(provider.handleEvent).parameter(0).toMatchTypeOf<{
      event: ThrottleEvent;
      credentials: Uint8Array;
      configuration: unknown;
    }>();
    expect([credentialStore, deliveryStore, clock, logger]).toHaveLength(4);
  });
});
