import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, test } from 'vitest';
import type { ThrottleEvent } from '../../packages/contracts/src/index.js';
import { createTestSystem, type TestSystem } from '../helpers/test-system.js';

const fixtureUrl = new URL(
  '../fixtures/throttle-events/order-created.json',
  import.meta.url,
);

async function orderCreated(): Promise<ThrottleEvent> {
  return JSON.parse(await readFile(fixtureUrl, 'utf8')) as ThrottleEvent;
}

async function prepare(system: TestSystem): Promise<void> {
  expect((await system.bootstrap()).status).toBe(200);
  expect((await system.connect()).status).toBe(200);
  expect((await system.configure({})).status).toBe(200);
}

describe('demo extension lifecycle', () => {
  let system: TestSystem | undefined;

  afterEach(async () => {
    await system?.dispose();
    system = undefined;
  });

  test('accepts one signed event and processes a duplicate exactly once', async () => {
    system = await createTestSystem();
    await prepare(system);
    const event = await orderCreated();

    expect((await system.deliver(event)).status).toBe(202);
    expect((await system.deliver(event)).status).toBe(202);
    expect(await system.jobCount()).toBe(1);

    await system.drainReadyQueue();

    expect(await system.jobState(event.id)).toMatchObject({
      status: 'completed',
      attempt: 1,
    });
    const response = await system.fetch('/api/activity');
    expect(response.status).toBe(200);
    const activities = await system.readActivities(response);
    expect(
      activities.filter(
        (activity) =>
          activity.eventId === event.id &&
          activity.type === 'connector_sync' &&
          activity.result === 'success',
      ),
    ).toHaveLength(1);
    expect(system.providerOrders()).toEqual([event.data.orderId]);
  });

  test('rejects an invalid webhook signature without accepting work', async () => {
    system = await createTestSystem();
    await prepare(system);
    const response = await system.deliver(await orderCreated(), {
      signatureSecret: 'wrong-secret',
    });

    expect(response.status).toBe(401);
    expect(await system.jobCount()).toBe(0);
    expect(system.queuedCount()).toBe(0);
    expect(JSON.stringify(await response.json())).not.toContain('wrong-secret');
  });

  test('rejects a JWT for another installation at the HTTP boundary', async () => {
    system = await createTestSystem();
    await prepare(system);

    const response = await system.fetch('/api/activity', undefined, {
      installationId: 'install-other',
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'ACCESS_DENIED' },
    });
  });

  test('processes out-of-order event timestamps as independent events', async () => {
    system = await createTestSystem();
    await prepare(system);
    const event = await orderCreated();
    const newer = {
      ...event,
      id: 'evt_newer',
      createdAt: '2026-07-19T11:59:00.000Z',
      data: { orderId: 'order-newer' },
    };
    const older = {
      ...event,
      id: 'evt_older',
      createdAt: '2026-07-19T10:00:00.000Z',
      data: { orderId: 'order-older' },
    };

    expect((await system.deliver(newer)).status).toBe(202);
    expect((await system.deliver(older)).status).toBe(202);
    await system.drainReadyQueue();

    expect(await system.jobState(newer.id)).toMatchObject({
      status: 'completed',
    });
    expect(await system.jobState(older.id)).toMatchObject({
      status: 'completed',
    });
    expect(system.providerOrders().sort()).toEqual([
      'order-newer',
      'order-older',
    ]);
  });

  test('retries a provider 429 and later completes the same durable job', async () => {
    system = await createTestSystem();
    await prepare(system);
    const event = { ...(await orderCreated()), id: 'evt_retry' };
    expect((await system.configure({ mode: '429' })).status).toBe(200);
    expect((await system.deliver(event)).status).toBe(202);

    await system.drainReadyQueue();
    expect(await system.jobState(event.id)).toMatchObject({
      status: 'retry',
      attempt: 1,
    });
    expect(system.queuedCount()).toBe(1);
    expect((await system.configure({})).status).toBe(200);
    system.advanceSeconds(5);
    await system.drainReadyQueue();

    expect(await system.jobState(event.id)).toMatchObject({
      status: 'completed',
      attempt: 2,
    });
    const activities = await system.activitiesFromApi();
    expect(
      activities
        .filter((activity) => activity.eventId === event.id)
        .map((activity) => activity.result),
    ).toEqual(expect.arrayContaining(['retryable_failure', 'success']));
  });

  test('stops after five retryable provider attempts', async () => {
    system = await createTestSystem();
    await prepare(system);
    const event = { ...(await orderCreated()), id: 'evt_exhausted' };
    expect((await system.configure({ mode: '429' })).status).toBe(200);
    expect((await system.deliver(event)).status).toBe(202);

    for (const delay of [5, 25, 125, 625, 0]) {
      await system.drainReadyQueue();
      if (delay > 0) system.advanceSeconds(delay);
    }

    expect(await system.jobState(event.id)).toMatchObject({
      status: 'failed',
      attempt: 5,
    });
    expect(system.queuedCount()).toBe(0);
    const attempts = (await system.activitiesFromApi()).filter(
      (activity) =>
        activity.eventId === event.id && activity.type === 'connector_sync',
    );
    expect(attempts).toHaveLength(5);
    expect(attempts.find((activity) => activity.attempt === 5)).toMatchObject({
      result: 'terminal_failure',
      code: 'ATTEMPTS_EXHAUSTED',
    });
  });

  test('records expired provider credentials as a terminal failure', async () => {
    system = await createTestSystem();
    await prepare(system);
    const event = { ...(await orderCreated()), id: 'evt_expired' };
    expect((await system.configure({ mode: 'expired' })).status).toBe(200);
    expect((await system.deliver(event)).status).toBe(202);

    await system.drainReadyQueue();

    expect(await system.jobState(event.id)).toMatchObject({
      status: 'failed',
      attempt: 1,
    });
    expect(
      (await system.activitiesFromApi()).find(
        (activity) =>
          activity.eventId === event.id && activity.type === 'connector_sync',
      ),
    ).toMatchObject({
      result: 'terminal_failure',
      code: 'TERMINAL_PROVIDER_ERROR',
    });
  });

  test('cancels accepted work when uninstalled before queue drain', async () => {
    system = await createTestSystem();
    await prepare(system);
    const event = { ...(await orderCreated()), id: 'evt_uninstalled' };
    expect((await system.deliver(event)).status).toBe(202);

    expect(
      (await system.fetch('/api/connector', { method: 'DELETE' })).status,
    ).toBe(200);
    await system.drainReadyQueue();

    expect(await system.jobState(event.id)).toMatchObject({
      status: 'cancelled',
      attempt: 0,
    });
    expect(system.providerOrders()).toEqual([]);
    expect((await system.fetch('/api/activity')).status).toBe(409);
  });
});
