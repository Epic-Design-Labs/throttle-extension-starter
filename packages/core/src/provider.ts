import type { ThrottleEvent } from '@starter/contracts';

export interface ProviderConnector {
  validateCredentials(
    credentials: Uint8Array,
  ): Promise<{ providerAccountReference: string }>;

  handleEvent(input: {
    event: ThrottleEvent;
    credentials: Uint8Array;
    configuration: unknown;
  }): Promise<void>;
}
