import {
  RetryableProviderError,
  TerminalProviderError,
  type ProviderConnector,
} from '@starter/core';

export interface DemoSink {
  recordOrderCreated(orderId: string, idempotencyKey: string): Promise<void>;
}
export interface DemoBehavior {
  onPage(page: number): Promise<void>;
}
export interface DemoProviderOptions {
  sink?: DemoSink;
  behavior?: DemoBehavior;
}

const expectedCredential = new TextEncoder().encode('demo-valid');
function validCredential(value: Uint8Array): boolean {
  if (value.length !== expectedCredential.length) return false;
  let difference = 0;
  for (let index = 0; index < value.length; index++)
    difference |= value[index]! ^ expectedCredential[index]!;
  return difference === 0;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createDemoProvider(
  options: DemoProviderOptions = {},
): ProviderConnector {
  const completedKeys = new Set<string>();
  return {
    async validateCredentials(credentials) {
      if (!validCredential(credentials)) throw new TerminalProviderError();
      return { providerAccountReference: 'demo-account' };
    },
    async handleEvent({ event, idempotencyKey, credentials, configuration }) {
      if (!validCredential(credentials)) throw new TerminalProviderError();
      const config = object(configuration);
      const mode = config?.mode;
      if (mode === '429' || mode === '500' || mode === 'timeout')
        throw new RetryableProviderError();
      if (mode === 'expired' || mode === 'malformed')
        throw new TerminalProviderError();
      if (mode === 'pagination') {
        const pages = config?.pages;
        if (
          !Number.isSafeInteger(pages) ||
          typeof pages !== 'number' ||
          pages < 1 ||
          pages > 100
        )
          throw new TerminalProviderError();
        for (let page = 1; page <= pages; page++)
          await options.behavior?.onPage(page);
      }
      if (event.type === 'order.created') {
        const orderId = event.data.orderId;
        if (typeof orderId !== 'string' || orderId.length === 0)
          throw new TerminalProviderError();
        if (!completedKeys.has(idempotencyKey)) {
          await options.sink?.recordOrderCreated(orderId, idempotencyKey);
          completedKeys.add(idempotencyKey);
        }
      }
    },
  };
}
