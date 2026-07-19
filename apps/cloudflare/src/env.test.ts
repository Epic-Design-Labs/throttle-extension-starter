import { expect, test } from 'vitest';
import { validateEnv } from './env.js';

const bindings = {
  DB: { prepare() {}, batch() {}, exec() {} },
  CONNECTOR_QUEUE: { send: async () => undefined },
  ENCRYPTION_KEY: 'CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk',
  ENCRYPTION_KEY_VERSION: '1',
  ENCRYPTION_KEYRING: '{}',
  THROTTLE_DASHBOARD_ORIGIN: 'https://dashboard.usethrottle.dev',
  THROTTLE_JWKS_URL:
    'https://api.usethrottle.dev/.well-known/extension-jwks.json',
  THROTTLE_EXTENSION_ID: 'ext_test_123',
  THROTTLE_READ_SCOPE: 'connector:read',
  THROTTLE_MUTATION_SCOPE: 'connector:write',
  QUEUE_MAX_ATTEMPTS: '5',
};

test('validates production bindings and decodes a 32-byte encryption key', () => {
  expect(validateEnv(bindings as never).currentKey.key.byteLength).toBe(32);
});

test('rejects insecure origins, placeholders, and malformed keyrings', () => {
  expect(() =>
    validateEnv({
      ...bindings,
      THROTTLE_DASHBOARD_ORIGIN: 'http://localhost:3000',
    } as never),
  ).toThrow();
  expect(() =>
    validateEnv({ ...bindings, THROTTLE_EXTENSION_ID: 'replace-me' } as never),
  ).toThrow();
  expect(() =>
    validateEnv({
      ...bindings,
      ENCRYPTION_KEYRING: '{"__proto__":"x"}',
    } as never),
  ).toThrow();
});
