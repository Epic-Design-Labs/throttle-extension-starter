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

/**
 * How long to wait before the next attempt.
 *
 * `retryAfterSeconds` is a provider's own `Retry-After`, and it is applied as
 * a **floor** beneath the exponential backoff rather than as a replacement for
 * it. RFC 9110 defines the header as the *minimum* time to wait, so treating
 * it as an exact schedule is a misreading — and a costly one: a provider
 * answering every 429 with `Retry-After: 1` would burn all `MAX_JOB_ATTEMPTS`
 * in a few seconds, where the backoff spreads them across roughly thirteen
 * minutes. As a floor the hint can only ever push a retry later, which is the
 * behaviour the header exists to buy, and a provider cannot use it to talk us
 * into hammering it.
 *
 * A hint beyond `MAX_RETRY_DELAY_SECONDS` is clamped. That does retry sooner
 * than the provider asked, which is a deliberate trade: parking a job for
 * hours on one provider's say-so is worse than absorbing one more 429.
 *
 * An unusable hint is ignored rather than rejected. It reaches us from a
 * response header, so a malformed one is bad input from outside rather than a
 * caller bug — and throwing here would be worse than useless: the only call
 * site is inside `processConnectorEvent`'s own catch block, so a throw escapes
 * the function entirely and surfaces to the queue consumer as an unhandled
 * error, turning an ordinary retryable failure into a crash on nothing worse
 * than a provider typo.
 */
export function retryDelaySeconds(
  attempt: number,
  retryAfterSeconds?: number,
): number {
  if (!Number.isInteger(attempt) || attempt <= 0) {
    throw new ValidationError();
  }

  const backoff = RETRY_BASE_SECONDS ** attempt;
  const floor =
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds > 0
      ? Math.ceil(retryAfterSeconds)
      : 0;

  return Math.min(Math.max(backoff, floor), MAX_RETRY_DELAY_SECONDS);
}
