import { describe, expect, it } from 'vitest';

import {
  activitySchema,
  connectorJobSchema,
  installationSchema,
  throttleEventSchema,
} from './index.js';

const createdAt = '2026-07-19T00:00:00.000Z';

const event = {
  id: 'evt_1',
  type: 'order.created',
  workspaceId: 'ws_1',
  environmentId: 'env_1',
  createdAt,
  data: { orderId: 'ord_1', provider: { region: 'west' } },
};

describe('installation contract', () => {
  const installation = {
    installationId: 'inst_1',
    workspaceId: 'ws_1',
    applicationId: 'app_1',
    environmentId: 'env_1',
    environmentKind: 'non_production',
    extensionVersion: '0.1.0',
    status: 'active',
    createdAt,
    updatedAt: createdAt,
  };

  it('accepts strict camelCase installation records', () => {
    expect(installationSchema.parse(installation)).toEqual(installation);
  });

  it('rejects retired snake_case fields', () => {
    expect(() =>
      installationSchema.parse({
        ...installation,
        installation_id: 'inst_1',
      }),
    ).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() =>
      installationSchema.parse({ ...installation, region: 'west' }),
    ).toThrow();
  });
});

describe('Throttle event contract', () => {
  it('preserves the public envelope and provider event data', () => {
    expect(throttleEventSchema.parse(event)).toEqual(event);
  });

  it('rejects unknown envelope keys', () => {
    expect(() =>
      throttleEventSchema.parse({ ...event, applicationId: 'app_1' }),
    ).toThrow();
  });

  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects dangerous payload key %s',
    (key) => {
      const data = Object.create(null) as Record<string, unknown>;
      data.orderId = 'ord_1';
      data[key] = { polluted: true };

      expect(() => throttleEventSchema.parse({ ...event, data })).toThrow();
    },
  );
});

describe('connector job contract', () => {
  const job = {
    jobId: 'job_1',
    installationId: 'inst_1',
    event,
    attempt: 1,
    createdAt,
  };

  it('carries identifiers and event data', () => {
    expect(connectorJobSchema.parse(job)).toEqual(job);
  });

  it.each([
    'apiKey',
    'signingSecret',
    'accessToken',
    'ciphertext',
    'providerCredentials',
  ])('rejects secret-bearing field %s', (field) => {
    expect(() =>
      connectorJobSchema.parse({ ...job, [field]: 'secret' }),
    ).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() =>
      connectorJobSchema.parse({ ...job, queueName: 'connector' }),
    ).toThrow();
  });
});

describe('activity contract', () => {
  const activity = {
    activityId: 'activity_1',
    installationId: 'inst_1',
    eventId: 'evt_1',
    jobId: 'job_1',
    type: 'connector_sync',
    status: 'completed',
    result: 'success',
    attempt: 1,
    message: 'Order synchronized',
    code: 'ORDER_SYNCED',
    createdAt,
  };

  it('accepts a sanitized connector history record', () => {
    expect(activitySchema.parse(activity)).toEqual(activity);
  });

  it.each([
    'apiKey',
    'token',
    'ciphertext',
    'providerCredentials',
    'rawProviderBody',
  ])('rejects secret-bearing or unsafe field %s', (field) => {
    expect(() =>
      activitySchema.parse({ ...activity, [field]: 'secret' }),
    ).toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() =>
      activitySchema.parse({ ...activity, durationMs: 10 }),
    ).toThrow();
  });
});
