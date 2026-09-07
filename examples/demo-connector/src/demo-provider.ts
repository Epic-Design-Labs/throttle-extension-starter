import {
  RetryableProviderError,
  TerminalProviderError,
  type ProviderConnector,
} from '@starter/core';

/**
 * The demo "provider"'s own wire shape. Its field names are deliberately
 * UNLIKE Throttle's (`id`, `shippingAddress.line1`, `shippingAddress.state`)
 * so that handleEvent below has to translate between the two. Assuming the two
 * sides share field names is the classic integration bug that passes every
 * test written against your own fixtures and then fails on live data — model
 * your real provider's mapper on the translation here, not on the demo's
 * inputs.
 */
export interface DemoShipment {
  referenceCode: string;
  addressLine1?: string;
  stateProvince?: string;
}
export interface DemoSink {
  recordShipment(shipment: DemoShipment, idempotencyKey: string): Promise<void>;
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
        // Real deliveries carry the full order object under data.order —
        // there is no top-level data.orderId.
        const order = object(event.data.order);
        const referenceCode = order?.id;
        if (typeof referenceCode !== 'string' || referenceCode.length === 0)
          throw new TerminalProviderError();
        // Translate Throttle's field names into the demo provider's. A real
        // integration has to do exactly this — the two schemas rarely agree,
        // and identical names on both sides is the bug that only shows up live.
        const address = object(order?.shippingAddress);
        const shipment: DemoShipment = {
          referenceCode,
          ...(typeof address?.line1 === 'string'
            ? { addressLine1: address.line1 }
            : {}),
          ...(typeof address?.state === 'string'
            ? { stateProvince: address.state }
            : {}),
        };
        if (!completedKeys.has(idempotencyKey)) {
          await options.sink?.recordShipment(shipment, idempotencyKey);
          completedKeys.add(idempotencyKey);
        }
      }
    },
  };
}
