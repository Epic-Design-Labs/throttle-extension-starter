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
const nonempty = z.string().min(1);
const claimsSchema = z
  .object({
    extensionId: nonempty,
    version: nonempty,
    installationId: nonempty,
    workspace: z.object({ id: nonempty, slug: nonempty }).strict(),
    application: z.object({ id: nonempty, slug: nonempty }).strict(),
    environment: z
      .object({
        environmentId: nonempty,
        environmentSlug: nonempty,
        environmentKind: nonempty,
        providerEnvironment: nonempty,
      })
      .strict(),
    role: nonempty,
    scopes: z
      .array(
        z
          .string()
          .min(1)
          .regex(
            /^(?!__proto__$)(?!prototype$)(?!constructor$)[A-Za-z0-9:_.*-]+$/u,
          ),
      )
      .max(100),
    user: z.object({ id: nonempty, email: z.email() }).strict(),
  })
  .strict();

export interface VerifiedExtensionIdentity {
  installationId: string;
  extensionId: string;
  version: string;
  workspaceId: string;
  applicationId: string;
  environmentId: string;
  environmentKind: string;
  providerEnvironment: string;
  role: string;
  scopes: string[];
  userId: string;
  userEmail: string;
}
export interface ExtensionIdentityVerifier {
  verify(token: unknown): Promise<VerifiedExtensionIdentity>;
}

export function createExtensionIdentityVerifier(options: {
  extensionId: string;
  issuer?: string;
  jwks?: JSONWebKeySet;
  jwksUrl?: string | URL;
  keyResolver?: JWTVerifyGetKey;
}): ExtensionIdentityVerifier {
  if (
    typeof options.extensionId !== 'string' ||
    options.extensionId.length === 0
  )
    throw new Error('A non-empty extensionId is required');
  const issuer = options.issuer ?? 'throttle';
  const resolver =
    options.keyResolver ??
    (options.jwks
      ? createLocalJWKSet(options.jwks)
      : createRemoteJWKSet(
          new URL(options.jwksUrl ?? DEFAULT_EXTENSION_JWKS_URL),
        ));
  return {
    async verify(token: unknown) {
      try {
        if (typeof token !== 'string' || token.length === 0) throw new Error();
        const { payload } = await jwtVerify(token, resolver, {
          issuer,
          audience: options.extensionId,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'exp', 'iat'],
          maxTokenAge: '10m',
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
        };
      } catch {
        throw new AuthenticationError();
      }
    },
  };
}
