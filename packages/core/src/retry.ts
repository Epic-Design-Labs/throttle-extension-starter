import { ValidationError } from './errors.js';

export type ProviderFailureClassification = 'retryable' | 'terminal';

export const MAX_JOB_ATTEMPTS = 5;

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_SECONDS = 900;
const RETRY_BASE_SECONDS = 5;

export function classifyProviderFailure(
  status: number,
): ProviderFailureClassification {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new ValidationError();
  }

  return RETRYABLE_HTTP_STATUSES.has(status) ? 'retryable' : 'terminal';
}

export function retryDelaySeconds(
  attempt: number,
  retryAfterSeconds?: number,
): number {
  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw new ValidationError();
  }

  if (retryAfterSeconds !== undefined) {
    // A provider-supplied Retry-After takes precedence over backoff, but is
    // still clamped to the cap so a hostile or absurd value can't stall a job.
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) {
      throw new ValidationError();
    }
    return Math.min(Math.ceil(retryAfterSeconds), MAX_RETRY_DELAY_SECONDS);
  }

  return Math.min(RETRY_BASE_SECONDS ** attempt, MAX_RETRY_DELAY_SECONDS);
}
