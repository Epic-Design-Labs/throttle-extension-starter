import { describe, expect, test } from 'vitest';
import { RetryableProviderError, TerminalProviderError } from '@starter/core';
import { createDemoProvider } from './demo-provider.js';

const event = {
  id: 'event-1',
  type: 'order.created',
  version: '1',
  workspaceId: 'workspace',
  environmentId: 'environment',
  createdAt: '2026-07-19T00:00:00.000Z',
  data: { order: { id: 'order-42' } },
} as const;
describe('fictional demo provider', () => {
  test('accepts only the exact demo credential and does not mutate it', async () => {
    const provider = createDemoProvider();
    const credential = new TextEncoder().encode('demo-valid');
    expect(await provider.validateCredentials(credential)).toEqual({
      providerAccountReference: 'demo-account',
    });
    expect(new TextDecoder().decode(credential)).toBe('demo-valid');
    await expect(
      provider.validateCredentials(new TextEncoder().encode('demo-valid\n')),
    ).rejects.toBeInstanceOf(TerminalProviderError);
  });
  test('records order.created IDs in an injected sink', async () => {
    const ids: string[] = [];
    const provider = createDemoProvider({
      sink: {
        recordOrderCreated: async (id) => {
          ids.push(id);
        },
      },
    });
    await provider.handleEvent({
      event,
      idempotencyKey: 'event-1',
      credentials: new TextEncoder().encode('demo-valid'),
      configuration: { mode: 'normal' },
    });
    expect(ids).toEqual(['order-42']);
  });
  test('deduplicates an effect by stable provider idempotency key', async () => {
    const ids: string[] = [];
    const provider = createDemoProvider({
      sink: {
        recordOrderCreated: async (id) => {
          ids.push(id);
        },
      },
    });
    const input = {
      event,
      idempotencyKey: 'stable-key',
      credentials: new TextEncoder().encode('demo-valid'),
      configuration: { mode: 'normal' },
    };
    await provider.handleEvent(input);
    await provider.handleEvent(input);
    expect(ids).toEqual(['order-42']);
  });
  test.each(['429', '500', 'timeout'] as const)(
    'offers deterministic retry mode %s',
    async (mode) => {
      const provider = createDemoProvider();
      await expect(
        provider.handleEvent({
          event,
          idempotencyKey: 'event-1',
          credentials: new TextEncoder().encode('demo-valid'),
          configuration: { mode },
        }),
      ).rejects.toBeInstanceOf(RetryableProviderError);
    },
  );
  test.each(['expired', 'malformed'] as const)(
    'offers deterministic terminal mode %s',
    async (mode) => {
      const provider = createDemoProvider();
      await expect(
        provider.handleEvent({
          event,
          idempotencyKey: 'event-1',
          credentials: new TextEncoder().encode('demo-valid'),
          configuration: { mode },
        }),
      ).rejects.toBeInstanceOf(TerminalProviderError);
    },
  );
  test('supports deterministic pagination through an injected behavior', async () => {
    const pages: number[] = [];
    const provider = createDemoProvider({
      behavior: {
        onPage: async (page) => {
          pages.push(page);
        },
      },
    });
    await provider.handleEvent({
      event,
      idempotencyKey: 'event-1',
      credentials: new TextEncoder().encode('demo-valid'),
      configuration: { mode: 'pagination', pages: 3 },
    });
    expect(pages).toEqual([1, 2, 3]);
  });
});
