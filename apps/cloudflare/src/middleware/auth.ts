import type { VerifiedExtensionIdentity } from '@starter/throttle';
import type { Context } from 'hono';
import { authenticationFailed, forbidden } from './errors.js';

export type Variables = {
  identity: VerifiedExtensionIdentity;
  requestId: string;
};

export function parseBearer(value: string | undefined): string {
  if (value === undefined) throw authenticationFailed();
  const match = /^Bearer ([^\s,]+)$/u.exec(value);
  if (!match) throw authenticationFailed();
  return match[1]!;
}

export function identity(c: Context<{ Variables: Variables }>) {
  return c.get('identity');
}

export function requireMutationRole(c: Context<{ Variables: Variables }>) {
  const role = identity(c).role;
  if (role !== 'admin' && role !== 'developer') throw forbidden();
}
