import type { ThrottleEvent } from '@starter/contracts';

export interface ProviderConnector {
  validateCredentials(
    credentials: Uint8Array,
  ): Promise<{ providerAccountReference: string }>;

  handleEvent(input: {
    event: ThrottleEvent;
    /**
     * The installation this event belongs to. Provided so a connector can key
     * installation-scoped state (e.g. a per-order watermark) and, if it calls
     * back into Throttle, look up that installation's stored throttleApiKey —
     * neither of which is otherwise reachable from inside handleEvent.
     */
    installationId: string;
    /** Stable across retries; providers must use this to deduplicate effects. */
    idempotencyKey: string;
    credentials: Uint8Array;
    configuration: unknown;
  }): Promise<void>;
}
