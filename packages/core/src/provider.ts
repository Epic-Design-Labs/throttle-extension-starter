import type { ThrottleEvent } from '@starter/contracts';

export interface ProviderConnector {
  validateCredentials(
    credentials: Uint8Array,
  ): Promise<{ providerAccountReference: string }>;

  handleEvent(input: {
    event: ThrottleEvent;
    /** Stable across retries; providers must use this to deduplicate effects. */
    idempotencyKey: string;
    credentials: Uint8Array;
    configuration: unknown;
  }): Promise<void>;
}
