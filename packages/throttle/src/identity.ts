import { AuthenticationError } from '@starter/core';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';
import { z } from 'zod';

export const DEFAULT_EXTENSION_JWKS_URL =
  'https://api.usethrottle.dev/.well-known/extension-jwks.json';
export const MAX_EXTENSION_TOKEN_BYTES = 16 * 1024;
export const MAX_EXTENSION_CLAIM_STRING_LENGTH = 256;
export const MAX_EXTENSION_SCOPE_LENGTH = 256;
const MAX_EXTENSION_VERSION_LENGTH = 128;
const MAX_EXTENSION_EMAIL_LENGTH = 320;
const EXTENSION_ISSUER = 'throttle';
const nonempty = z.string().min(1).max(MAX_EXTENSION_CLAIM_STRING_LENGTH);
const claimsSchema = z
  .object({
    extensionId: nonempty,
    version: z.string().min(1).max(MAX_EXTENSION_VERSION_LENGTH),
    installationId: nonempty,
    workspace: z.object({ id: nonempty, slug: nonempty }).strict(),
    application: z.object({ id: nonempty, slug: nonempty }).strict(),
    environment: z
      .object({
        environmentId: nonempty,
        environmentSlug: nonempty,
        environmentKind: z.enum(['production', 'non_production']),
        providerEnvironment: z.enum(['production', 'sandbox']),
      })
      .strict(),
    role: z.enum(['admin', 'developer', 'finance', 'viewer']),
    scopes: z
      .array(
        z
          .string()
          .min(1)
          .max(MAX_EXTENSION_SCOPE_LENGTH)
          .regex(
            /^(?!__proto__$)(?!prototype$)(?!constructor$)[A-Za-z0-9:_.*-]+$/u,
          ),
      )
      .max(100),
    user: z
      .object({
        id: nonempty,
        email: z.email().max(MAX_EXTENSION_EMAIL_LENGTH),
        name: nonempty.optional(),
      })
      .strict(),
  })
  .strict();

export interface VerifiedExtensionIdentity {
  installationId: string;
  extensionId: string;
  version: string;
  workspaceId: string;
  applicationId: string;
  environmentId: string;
  environmentKind: 'production' | 'non_production';
  providerEnvironment: 'production' | 'sandbox';
  role: 'admin' | 'developer' | 'finance' | 'viewer';
  scopes: string[];
  userId: string;
  userEmail: string;
  userName?: string;
}
export interface ExtensionIdentityVerifier {
  verify(token: unknown): Promise<VerifiedExtensionIdentity>;
}

export function createExtensionIdentityVerifier(options: {
  extensionId: string;
  jwks?: JSONWebKeySet;
  jwksUrl?: string | URL;
  keyResolver?: JWTVerifyGetKey;
  currentDate?: () => Date;
}): ExtensionIdentityVerifier {
  if (
    typeof options.extensionId !== 'string' ||
    options.extensionId.length === 0
  )
    throw new Error('A non-empty extensionId is required');
  let resolver: JWTVerifyGetKey;
  if (options.keyResolver) resolver = options.keyResolver;
  else if (options.jwks) resolver = createLocalJWKSet(options.jwks);
  else {
    const jwksUrl = new URL(options.jwksUrl ?? DEFAULT_EXTENSION_JWKS_URL);
    if (jwksUrl.protocol !== 'https:')
      throw new Error('Remote JWKS URL must use HTTPS');
    resolver = createRemoteJWKSet(jwksUrl);
  }
  return {
    async verify(token: unknown) {
      try {
        if (
          typeof token !== 'string' ||
          token.length === 0 ||
          new TextEncoder().encode(token).byteLength > MAX_EXTENSION_TOKEN_BYTES
        )
          throw new Error();
        const { payload } = await jwtVerify(token, resolver, {
          issuer: EXTENSION_ISSUER,
          audience: options.extensionId,
          algorithms: ['RS256'],
          // Platform launch tokens carry iss/sub/aud/iat/exp only — nbf is
          // never minted, so requiring it would reject every real token.
          // When nbf IS present, jose still validates it.
          requiredClaims: ['sub', 'exp', 'iat'],
          maxTokenAge: '10m',
          ...(options.currentDate === undefined
            ? {}
            : { currentDate: options.currentDate() }),
        });
        const custom = claimsSchema.parse(
          Object.fromEntries(
            Object.entries(payload).filter(
              ([key]) =>
                !['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti'].includes(
                  key,
                ),
            ),
          ),
        );
        if (
          payload.sub !== custom.installationId ||
          payload.aud !== options.extensionId ||
          custom.extensionId !== options.extensionId ||
          new Set(custom.scopes).size !== custom.scopes.length
        )
          throw new Error();
        return {
          installationId: custom.installationId,
          extensionId: custom.extensionId,
          version: custom.version,
          workspaceId: custom.workspace.id,
          applicationId: custom.application.id,
          environmentId: custom.environment.environmentId,
          environmentKind: custom.environment.environmentKind,
          providerEnvironment: custom.environment.providerEnvironment,
          role: custom.role,
          scopes: [...custom.scopes],
          userId: custom.user.id,
          userEmail: custom.user.email,
          ...(custom.user.name === undefined
            ? {}
            : { userName: custom.user.name }),
        };
      } catch {
        throw new AuthenticationError();
      }
    },
  };
}
