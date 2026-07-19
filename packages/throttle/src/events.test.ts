import { expect, it } from 'vitest';
import {
  MAX_WEBHOOK_BODY_BYTES,
  MAX_WEBHOOK_VERIFICATION_CANDIDATES,
  parseWebhookRoutingHint,
} from './events.js';

it('extracts only explicitly untrusted routing identifiers', () => {
  expect(
    parseWebhookRoutingHint(
      '{"workspaceId":"ws_1","environmentId":"env_1","secret":"no"}',
    ),
  ).toEqual({ trusted: false, workspaceId: 'ws_1', environmentId: 'env_1' });
});
it('rejects empty, oversized, invalid, and deeply nested bodies', () => {
  expect(parseWebhookRoutingHint('{}')).toBeNull();
  expect(
    parseWebhookRoutingHint('x'.repeat(MAX_WEBHOOK_BODY_BYTES + 1)),
  ).toBeNull();
  expect(parseWebhookRoutingHint('{')).toBeNull();
  expect(
    parseWebhookRoutingHint(
      '{"workspaceId":"w","environmentId":"e","x":[[[[[[[[[[[1]]]]]]]]]]]}',
    ),
  ).toBeNull();
});
it('exports a concrete bounded candidate limit', () =>
  expect(MAX_WEBHOOK_VERIFICATION_CANDIDATES).toBe(100));
