import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, expect, it } from 'vitest';
import { createExtensionIdentityVerifier } from './identity.js';

let privateKey: CryptoKey;
let verifier: ReturnType<typeof createExtensionIdentityVerifier>;
const fixedNowSeconds = 1_800_000_000;
const claims = {
  extensionId: 'ext_1',
  version: '1.0.0',
  installationId: 'inst_1',
  workspace: { id: 'ws_1', slug: 'workspace' },
  application: { id: 'app_1', slug: 'app' },
  environment: {
    environmentId: 'env_1',
    environmentSlug: 'prod',
    environmentKind: 'production',
    providerEnvironment: 'production',
  },
  role: 'admin',
  scopes: ['deploy:read'],
  user: { id: 'user_1', email: 'u@example.com' },
};

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'key-1';
  jwk.alg = 'RS256';
  verifier = createExtensionIdentityVerifier({
    extensionId: 'ext_1',
    jwks: { keys: [jwk] },
    currentDate: () => new Date(fixedNowSeconds * 1000),
  });
});
const token = async (overrides: Record<string, unknown> = {}, alg = 'RS256') =>
  new SignJWT({ ...claims, ...overrides })
    .setProtectedHeader({ alg, kid: 'key-1' })
    .setIssuer('throttle')
    .setSubject('inst_1')
    .setAudience('ext_1')
    .setIssuedAt(fixedNowSeconds)
    .setNotBefore(fixedNowSeconds)
    .setExpirationTime(fixedNowSeconds + 600)
    .sign(privateKey);

it('verifies and narrows a valid extension identity', async () => {
  await expect(verifier.verify(await token())).resolves.toEqual({
    installationId: 'inst_1',
    extensionId: 'ext_1',
    version: '1.0.0',
    workspaceId: 'ws_1',
    applicationId: 'app_1',
    environmentId: 'env_1',
    environmentKind: 'production',
    providerEnvironment: 'production',
    role: 'admin',
    scopes: ['deploy:read'],
    userId: 'user_1',
    userEmail: 'u@example.com',
  });
});
it.each([
  ['mismatched installation', { installationId: 'inst_2' }],
  ['missing nested claim', { workspace: undefined }],
  ['duplicate scope', { scopes: ['a', 'a'] }],
  ['empty scope', { scopes: [''] }],
  ['unsafe scope', { scopes: ['__proto__'] }],
  ['unknown claim field', { unexpected: true }],
  [
    'unknown environment kind',
    { environment: { ...claims.environment, environmentKind: 'preview' } },
  ],
  [
    'unknown provider environment',
    { environment: { ...claims.environment, providerEnvironment: 'staging' } },
  ],
  ['unknown role', { role: 'owner' }],
])(
  'rejects %s',
  async (_name, overrides) =>
    await expect(verifier.verify(await token(overrides))).rejects.toMatchObject(
      { code: 'authenticationError' },
    ),
);
it('does not expose rejected claims through the authentication error', async () => {
  try {
    await verifier.verify(
      await token({ workspace: { id: '', slug: 'secret-slug' } }),
    );
    throw new Error('expected authentication failure');
  } catch (error) {
    expect(error).toMatchObject({ code: 'authenticationError' });
    expect('cause' in (error as object)).toBe(false);
  }
});
it('accepts and exposes an optional nonempty user name', async () => {
  await expect(
    verifier.verify(await token({ user: { ...claims.user, name: 'Ada' } })),
  ).resolves.toMatchObject({ userName: 'Ada' });
  await expect(
    verifier.verify(await token({ user: { ...claims.user, name: '' } })),
  ).rejects.toMatchObject({ code: 'authenticationError' });
});
it('rejects wrong issuer, audience, expiry, future nbf, and unknown kid', async () => {
  const base = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'missing' })
    .setIssuer('wrong')
    .setSubject('inst_1')
    .setAudience('wrong')
    .setExpirationTime(0);
  await expect(
    verifier.verify(await base.sign(privateKey)),
  ).rejects.toMatchObject({ code: 'authenticationError' });
  const future = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer('throttle')
    .setSubject('inst_1')
    .setAudience('ext_1')
    .setIssuedAt(fixedNowSeconds)
    .setNotBefore(fixedNowSeconds + 60)
    .setExpirationTime(fixedNowSeconds + 600);
  await expect(
    verifier.verify(await future.sign(privateKey)),
  ).rejects.toMatchObject({ code: 'authenticationError' });
});
it('requires standard expiration, not-before, and issued-at claims', async () => {
  const missingTimes = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer('throttle')
    .setSubject('inst_1')
    .setAudience('ext_1');
  await expect(
    verifier.verify(await missingTimes.sign(privateKey)),
  ).rejects.toMatchObject({ code: 'authenticationError' });
});
it('enforces exact audience shape and fixed issuer configuration', async () => {
  const multipleAudiences = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer('throttle')
    .setSubject('inst_1')
    .setAudience(['ext_1', 'other'])
    .setIssuedAt(fixedNowSeconds)
    .setNotBefore(fixedNowSeconds)
    .setExpirationTime(fixedNowSeconds + 600);
  await expect(
    verifier.verify(await multipleAudiences.sign(privateKey)),
  ).rejects.toMatchObject({ code: 'authenticationError' });
  const wrongIssuer = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer('other')
    .setSubject('inst_1')
    .setAudience('ext_1')
    .setIssuedAt(fixedNowSeconds)
    .setNotBefore(fixedNowSeconds)
    .setExpirationTime(fixedNowSeconds + 600);
  await expect(
    verifier.verify(await wrongIssuer.sign(privateKey)),
  ).rejects.toMatchObject({ code: 'authenticationError' });
});
it('rejects a token missing only nbf', async () => {
  const missingNbf = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
    .setIssuer('throttle')
    .setSubject('inst_1')
    .setAudience('ext_1')
    .setIssuedAt(fixedNowSeconds)
    .setExpirationTime(fixedNowSeconds + 600);
  await expect(
    verifier.verify(await missingNbf.sign(privateKey)),
  ).rejects.toMatchObject({ code: 'authenticationError' });
});
it('accepts iat/nbf boundaries and rejects old or future iat', async () => {
  const timedToken = (issuedAt: number, notBefore: number) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer('throttle')
      .setSubject('inst_1')
      .setAudience('ext_1')
      .setIssuedAt(issuedAt)
      .setNotBefore(notBefore)
      .setExpirationTime(fixedNowSeconds + 600)
      .sign(privateKey);
  await expect(
    verifier.verify(await timedToken(fixedNowSeconds - 600, fixedNowSeconds)),
  ).resolves.toMatchObject({ installationId: 'inst_1' });
  await expect(
    verifier.verify(await timedToken(fixedNowSeconds - 601, fixedNowSeconds)),
  ).rejects.toMatchObject({ code: 'authenticationError' });
  await expect(
    verifier.verify(await timedToken(fixedNowSeconds + 1, fixedNowSeconds)),
  ).rejects.toMatchObject({ code: 'authenticationError' });
});
