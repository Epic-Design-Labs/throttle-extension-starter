import type { ActivityStore, Clock } from '@starter/core';
import type { QueueFailureRecord } from './consumer.js';

/**
 * Persists an idempotent sanitized delivery-failure activity. Queue consumers
 * do not possess the execution lease token, so this deliberately never mutates
 * the job row; terminal records require later fenced reconciliation.
 */
export function createActivityStoreQueueFailureRecorder(dependencies: {
  activities: ActivityStore;
  clock: Clock;
}): (failure: QueueFailureRecord) => Promise<void> {
  return async (failure) => {
    await dependencies.activities.append({
      activityId: JSON.stringify([
        'queue_failure',
        failure.jobId,
        failure.messageId,
        failure.deliveryAttempt,
      ]),
      installationId: failure.installationId,
      eventId: failure.eventId,
      jobId: failure.jobId,
      type: 'connector_sync',
      status: 'completed',
      result: failure.terminal ? 'terminal_failure' : 'retryable_failure',
      attempt: failure.deliveryAttempt,
      code: failure.terminal ? 'QUEUE_DELIVERY_EXHAUSTED' : failure.code,
      createdAt: dependencies.clock.now().toISOString(),
    });
  };
}
