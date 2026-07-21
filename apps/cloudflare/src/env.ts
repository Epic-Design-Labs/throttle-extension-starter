import type { CloudflareQueue } from '@starter/adapters-cloudflare-queue';
import type { D1Database } from '@starter/adapters-d1';

export interface Env {
  DB: D1Database;
  CONNECTOR_QUEUE: CloudflareQueue;
  ENCRYPTION_KEY: string;
  ENCRYPTION_KEY_VERSION: string;
  ENCRYPTION_KEYRING: string;
  THROTTLE_DASHBOARD_ORIGIN: string;
  EXTENSION_UI_ORIGIN?: string;
  THROTTLE_JWKS_URL: string;
  THROTTLE_EXTENSION_ID: string;
  THROTTLE_READ_SCOPE: string;
  THROTTLE_MUTATION_SCOPE: string;
  QUEUE_MAX_ATTEMPTS: string;
}

function bytes(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length % 4 === 1
  )
    throw new Error('Encryption keys must be base64url');
  const standard = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='));
  const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (decoded.byteLength !== 32)
    throw new Error('Encryption keys must decode to 32 bytes');
  return decoded;
}
function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/u.test(value))
    throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is invalid`);
  return parsed;
}
function httpsUrl(value: unknown, name: string, originOnly = false): string {
  if (typeof value !== 'string') throw new Error(`${name} is required`);
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || (originOnly && parsed.origin !== value))
    throw new Error(`${name} must use HTTPS`);
  return value;
}

export function validateEnv(env: Env) {
  if (!env.DB || typeof env.DB.prepare !== 'function')
    throw new Error('DB binding is required');
  if (!env.CONNECTOR_QUEUE || typeof env.CONNECTOR_QUEUE.send !== 'function')
    throw new Error('Queue binding is required');
  const version = positiveInteger(
    env.ENCRYPTION_KEY_VERSION,
    'ENCRYPTION_KEY_VERSION',
  );
  const keys = new Map<number, Uint8Array>([
    [version, bytes(env.ENCRYPTION_KEY)],
  ]);
  let prior: unknown;
  try {
    prior = JSON.parse(env.ENCRYPTION_KEYRING);
  } catch {
    throw new Error('ENCRYPTION_KEYRING must be JSON');
  }
  if (typeof prior !== 'object' || prior === null || Array.isArray(prior))
    throw new Error('ENCRYPTION_KEYRING must be an object');
  for (const [key, value] of Object.entries(prior)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor')
      throw new Error('ENCRYPTION_KEYRING contains an unsafe key');
    const priorVersion = positiveInteger(key, 'keyring version');
    if (priorVersion === version)
      throw new Error('Current key must not be duplicated');
    keys.set(priorVersion, bytes(value));
  }
  if (
    typeof env.THROTTLE_EXTENSION_ID !== 'string' ||
    env.THROTTLE_EXTENSION_ID.length < 1 ||
    /replace|placeholder|change-me/iu.test(env.THROTTLE_EXTENSION_ID)
  )
    throw new Error('A deployed extension ID is required');
  for (const [name, scope] of [
    ['THROTTLE_READ_SCOPE', env.THROTTLE_READ_SCOPE],
    ['THROTTLE_MUTATION_SCOPE', env.THROTTLE_MUTATION_SCOPE],
  ] as const) {
    if (
      typeof scope !== 'string' ||
      !/^(?!__proto__$)(?!prototype$)(?!constructor$)[A-Za-z0-9:_.*-]+$/u.test(
        scope,
      )
    )
      throw new Error(`${name} is invalid`);
  }
  const queueMaxAttempts = positiveInteger(
    env.QUEUE_MAX_ATTEMPTS,
    'QUEUE_MAX_ATTEMPTS',
  );
  if (queueMaxAttempts > 100)
    throw new Error('QUEUE_MAX_ATTEMPTS is too large');
  return {
    database: env.DB,
    queue: env.CONNECTOR_QUEUE,
    dashboardOrigin: httpsUrl(
      env.THROTTLE_DASHBOARD_ORIGIN,
      'THROTTLE_DASHBOARD_ORIGIN',
      true,
    ),
    // Optional: the origin the extension UI is served from. The iframe UI
    // calls this Worker cross-origin, so CORS must allow it. Empty/unset
    // means "not configured" (only sensible when the Worker serves the UI).
    uiOrigin: env.EXTENSION_UI_ORIGIN
      ? httpsUrl(env.EXTENSION_UI_ORIGIN, 'EXTENSION_UI_ORIGIN', true)
      : undefined,
    jwksUrl: httpsUrl(env.THROTTLE_JWKS_URL, 'THROTTLE_JWKS_URL'),
    extensionId: env.THROTTLE_EXTENSION_ID,
    authorizationScopes: {
      read: env.THROTTLE_READ_SCOPE,
      mutation: env.THROTTLE_MUTATION_SCOPE,
    },
    queueMaxAttempts,
    currentKey: { version, key: keys.get(version)! },
    keyring: {
      current: () => ({ version, key: new Uint8Array(keys.get(version)!) }),
      resolve: (requested: number) => {
        const key = keys.get(requested);
        return key ? new Uint8Array(key) : undefined;
      },
    },
  };
}
