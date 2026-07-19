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
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ENVELOPE_FIELDS = [
  'algorithm',
  'ciphertext',
  'iv',
  'keyVersion',
] as const;

const copyBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> =>
  new Uint8Array(bytes);

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
    rootKey.byteLength !== ROOT_KEY_LENGTH
  ) {
    throw new Error('Root key must be exactly 32 bytes');
  }
  return copyBytes(rootKey);
};

const validateContext = (installationId: string): Uint8Array<ArrayBuffer> => {
  if (typeof installationId !== 'string' || installationId.length === 0) {
    throw new Error('A non-empty installation context is required');
  }
  return new TextEncoder().encode(installationId);
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
 */
export async function encryptSecret(
  plaintext: Uint8Array,
  rootKey: Uint8Array,
  installationId: string,
  keyVersion = 1,
): Promise<EncryptedSecret> {
  validateKeyVersion(keyVersion);
  const keyBytes = validateRootKey(rootKey);
  const additionalData = validateContext(installationId);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await importKey(keyBytes);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    copyBytes(plaintext),
  );
  return {
    algorithm: ALGORITHM,
    keyVersion,
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  };
}

/** Returns newly allocated caller-owned plaintext bytes. */
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
    const descriptors = Object.getOwnPropertyDescriptors(envelope);
    const fields = Object.entries(descriptors)
      .filter(([, descriptor]) => descriptor.enumerable)
      .map(([field]) => field)
      .sort();
    if (
      fields.length !== ENVELOPE_FIELDS.length ||
      fields.some((field, index) => field !== ENVELOPE_FIELDS[index]) ||
      ENVELOPE_FIELDS.some((field) => !('value' in descriptors[field]!))
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
      { name: 'AES-GCM', iv, additionalData: validateContext(installationId) },
      key,
      ciphertext,
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error(DECRYPTION_ERROR);
  }
}
