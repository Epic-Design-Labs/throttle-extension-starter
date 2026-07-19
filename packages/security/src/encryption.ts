export interface EncryptedSecret {
  algorithm: 'A256GCM';
  keyVersion: number;
  iv: string;
  ciphertext: string;
}

const ALGORITHM = 'A256GCM' as const;
const IV_LENGTH = 12;
const ROOT_KEY_LENGTH = 32;
const DECRYPTION_ERROR = 'Unable to decrypt secret';
const AAD_DOMAIN = 'throttle-security:aes-256-gcm:v1';
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ENVELOPE_FIELDS = [
  'algorithm',
  'ciphertext',
  'iv',
  'keyVersion',
] as const;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const TYPED_ARRAY_BYTE_LENGTH = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteLength',
)!.get!;

const byteLength = (bytes: Uint8Array): number =>
  TYPED_ARRAY_BYTE_LENGTH.call(bytes) as number;

const copyBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(byteLength(bytes));
  Uint8Array.prototype.set.call(copy, bytes);
  return copy;
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
};

const decodeBase64Url = (encoded: unknown): Uint8Array<ArrayBuffer> => {
  if (
    typeof encoded !== 'string' ||
    !BASE64URL.test(encoded) ||
    encoded.length % 4 === 1
  ) {
    throw new Error(DECRYPTION_ERROR);
  }
  const standard = encoded.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, '='));
  const decoded = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (encodeBase64Url(decoded) !== encoded) throw new Error(DECRYPTION_ERROR);
  return decoded;
};

const validateRootKey = (rootKey: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (
    !(rootKey instanceof Uint8Array) ||
    byteLength(rootKey) !== ROOT_KEY_LENGTH
  ) {
    throw new Error('Root key must be exactly 32 bytes');
  }
  return copyBytes(rootKey);
};

const validatePlaintext = (plaintext: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (!(plaintext instanceof Uint8Array)) {
    throw new Error('Plaintext must be a Uint8Array');
  }
  return copyBytes(plaintext);
};

const encodeAdditionalData = (
  installationId: string,
  keyVersion: number,
): Uint8Array<ArrayBuffer> => {
  if (typeof installationId !== 'string' || installationId.length === 0) {
    throw new Error('A non-empty installation context is required');
  }
  // Canonical JSON array gives the AAD an unambiguous field order and type
  // boundary. The versioned domain separates this ciphertext from other uses.
  return new TextEncoder().encode(
    JSON.stringify([AAD_DOMAIN, installationId, keyVersion]),
  );
};

const validateKeyVersion = (keyVersion: number): void => {
  if (!Number.isSafeInteger(keyVersion) || keyVersion <= 0) {
    throw new Error('Encryption key version must be a positive integer');
  }
};

const importKey = (rootKey: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', rootKey, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);

/**
 * Encrypts caller-owned bytes without mutating them. The returned envelope owns
 * its encoded data; callers likewise own and may clear their input when desired.
 * Byte inputs must be same-realm Uint8Array instances.
 */
export async function encryptSecret(
  plaintext: Uint8Array,
  rootKey: Uint8Array,
  installationId: string,
  keyVersion = 1,
): Promise<EncryptedSecret> {
  validateKeyVersion(keyVersion);
  const keyBytes = validateRootKey(rootKey);
  const additionalData = encodeAdditionalData(installationId, keyVersion);
  const plaintextBytes = validatePlaintext(plaintext);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await importKey(keyBytes);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    plaintextBytes,
  );
  return {
    algorithm: ALGORITHM,
    keyVersion,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

/**
 * Returns newly allocated caller-owned plaintext bytes. Root keys must be
 * same-realm Uint8Array instances.
 */
export async function decryptSecret(
  envelope: unknown,
  rootKey: Uint8Array,
  installationId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      Array.isArray(envelope)
    ) {
      throw new Error(DECRYPTION_ERROR);
    }
    const ownKeys = Reflect.ownKeys(envelope);
    const fields = ownKeys
      .filter((field): field is string => typeof field === 'string')
      .sort();
    if (
      ownKeys.length !== ENVELOPE_FIELDS.length ||
      fields.length !== ENVELOPE_FIELDS.length ||
      fields.some((field, index) => field !== ENVELOPE_FIELDS[index])
    ) {
      throw new Error(DECRYPTION_ERROR);
    }
    const descriptors = Object.getOwnPropertyDescriptors(envelope);
    if (
      ENVELOPE_FIELDS.some((field) => {
        const descriptor = descriptors[field];
        return (
          !descriptor || !descriptor.enumerable || !('value' in descriptor)
        );
      })
    ) {
      throw new Error(DECRYPTION_ERROR);
    }
    const value = Object.fromEntries(
      ENVELOPE_FIELDS.map((field) => [field, descriptors[field]!.value]),
    ) as Record<string, unknown>;
    if (value.algorithm !== ALGORITHM) throw new Error(DECRYPTION_ERROR);
    validateKeyVersion(value.keyVersion as number);
    const iv = decodeBase64Url(value.iv);
    const ciphertext = decodeBase64Url(value.ciphertext);
    if (iv.byteLength !== IV_LENGTH || ciphertext.byteLength < 16) {
      throw new Error(DECRYPTION_ERROR);
    }
    const key = await importKey(validateRootKey(rootKey));
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: encodeAdditionalData(
          installationId,
          value.keyVersion as number,
        ),
      },
      key,
      ciphertext,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error(DECRYPTION_ERROR);
  }
}
