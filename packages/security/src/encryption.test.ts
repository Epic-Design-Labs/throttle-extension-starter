import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from './encryption.js';

const encoder = new TextEncoder();
const validKey = () => crypto.getRandomValues(new Uint8Array(32));
const decodeBase64Url = (value: string) =>
  Uint8Array.from(
    atob(
      value
        .replaceAll('-', '+')
        .replaceAll('_', '/')
        .padEnd(Math.ceil(value.length / 4) * 4, '='),
    ),
    (character) => character.charCodeAt(0),
  );
const encodeBase64Url = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');

describe('secret encryption', () => {
  it('round-trips only with matching installation context', async () => {
    const key = validKey();
    const encrypted = await encryptSecret(
      encoder.encode('secret'),
      key,
      'inst_1',
    );
    await expect(decryptSecret(encrypted, key, 'inst_1')).resolves.toEqual(
      encoder.encode('secret'),
    );
    await expect(decryptSecret(encrypted, key, 'inst_2')).rejects.toThrow();
  });

  it('uses a fresh 12-byte IV for every encryption', async () => {
    const key = validKey();
    const first = await encryptSecret(encoder.encode('secret'), key, 'inst_1');
    const second = await encryptSecret(encoder.encode('secret'), key, 'inst_1');
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(decodeBase64Url(first.iv)).toHaveLength(12);
  });

  it.each(['ciphertext', 'iv'] as const)(
    'rejects tampered %s generically',
    async (field) => {
      const key = validKey();
      const encrypted = await encryptSecret(
        encoder.encode('secret'),
        key,
        'inst_1',
      );
      const bytes = decodeBase64Url(encrypted[field]);
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      const tampered = { ...encrypted, [field]: encodeBase64Url(bytes) };
      await expect(decryptSecret(tampered, key, 'inst_1')).rejects.toThrow(
        'Unable to decrypt secret',
      );
    },
  );

  it('rejects the wrong key generically', async () => {
    const encrypted = await encryptSecret(
      encoder.encode('secret'),
      validKey(),
      'inst_1',
    );
    await expect(
      decryptSecret(encrypted, validKey(), 'inst_1'),
    ).rejects.toThrow('Unable to decrypt secret');
  });

  it('authenticates the canonical key version in additional data', async () => {
    const key = validKey();
    const encrypted = await encryptSecret(
      encoder.encode('secret'),
      key,
      'inst_1',
      7,
    );
    await expect(
      decryptSecret({ ...encrypted, keyVersion: 8 }, key, 'inst_1'),
    ).rejects.toThrow('Unable to decrypt secret');
  });

  it.each([
    { algorithm: 'AES-GCM' },
    { keyVersion: 0 },
    { keyVersion: 1.5 },
    { iv: '***' },
    { iv: 'AA' },
    { ciphertext: 'standard/base64+' },
    { ciphertext: 'A' },
  ])('rejects malformed envelopes generically: %o', async (change) => {
    const key = validKey();
    const encrypted = await encryptSecret(
      encoder.encode('secret'),
      key,
      'inst_1',
    );
    await expect(
      decryptSecret({ ...encrypted, ...change }, key, 'inst_1'),
    ).rejects.toThrow('Unable to decrypt secret');
  });

  it('rejects envelopes with fields outside the strict serialized shape', async () => {
    const key = validKey();
    const encrypted = await encryptSecret(
      encoder.encode('secret'),
      key,
      'inst_1',
    );
    await expect(
      decryptSecret(
        { ...encrypted, authorization: 'Bearer leak' },
        key,
        'inst_1',
      ),
    ).rejects.toThrow('Unable to decrypt secret');
  });

  it.each(['hidden', 'symbol', 'accessor'] as const)(
    'rejects an envelope containing an extra %s own key without invoking accessors',
    async (kind) => {
      let calls = 0;
      const key = validKey();
      const envelope: object = await encryptSecret(
        encoder.encode('secret'),
        key,
        'inst_1',
      );
      if (kind === 'hidden') {
        Object.defineProperty(envelope, 'hidden', { value: 'leak' });
      } else if (kind === 'symbol') {
        Object.defineProperty(envelope, Symbol('leak'), { value: 'leak' });
      } else {
        Object.defineProperty(envelope, 'extra', {
          get: () => {
            calls += 1;
            return 'leak';
          },
        });
      }
      await expect(decryptSecret(envelope, key, 'inst_1')).rejects.toThrow(
        'Unable to decrypt secret',
      );
      expect(calls).toBe(0);
    },
  );

  it('rejects an accessor for a required envelope field without invoking it', async () => {
    let calls = 0;
    const key = validKey();
    const envelope = await encryptSecret(
      encoder.encode('secret'),
      key,
      'inst_1',
    );
    Object.defineProperty(envelope, 'ciphertext', {
      enumerable: true,
      get: () => {
        calls += 1;
        return 'leak';
      },
    });
    await expect(decryptSecret(envelope, key, 'inst_1')).rejects.toThrow(
      'Unable to decrypt secret',
    );
    expect(calls).toBe(0);
  });

  it.each([
    new Uint8Array(0),
    new Uint8Array(16),
    new Uint8Array(31),
    new Uint8Array(33),
  ])('rejects a root key that is not 32 bytes', async (key) => {
    await expect(
      encryptSecret(encoder.encode('secret'), key, 'inst_1'),
    ).rejects.toThrow('32 bytes');
    await expect(
      decryptSecret(
        {
          algorithm: 'A256GCM',
          keyVersion: 1,
          iv: 'AAAAAAAAAAAAAAAA',
          ciphertext: 'AA',
        },
        key,
        'inst_1',
      ),
    ).rejects.toThrow('Unable to decrypt secret');
  });

  it('rejects empty installation context', async () => {
    await expect(
      encryptSecret(encoder.encode('secret'), validKey(), ''),
    ).rejects.toThrow('installation');
  });

  it.each([null, [], 1, new ArrayBuffer(2)])(
    'rejects non-Uint8Array plaintext input: %o',
    async (plaintext) => {
      await expect(
        encryptSecret(plaintext as unknown as Uint8Array, validKey(), 'inst_1'),
      ).rejects.toThrow('Uint8Array');
    },
  );

  it('validates Uint8Array keys without invoking overridden properties', async () => {
    let calls = 0;
    const key = validKey();
    Object.defineProperties(key, {
      byteLength: {
        get: () => {
          calls += 1;
          return 0;
        },
      },
      slice: {
        value: () => {
          calls += 1;
          return new Uint8Array();
        },
      },
      constructor: {
        get: () => {
          calls += 1;
          return Uint8Array;
        },
      },
    });
    const envelope = await encryptSecret(
      encoder.encode('secret'),
      key,
      'inst_1',
    );
    await expect(decryptSecret(envelope, key, 'inst_1')).resolves.toEqual(
      encoder.encode('secret'),
    );
    expect(calls).toBe(0);
  });

  it.each([new Uint8Array(), new Uint8Array([0, 255, 1, 128])])(
    'round-trips empty and arbitrary binary secrets',
    async (secret) => {
      const key = validKey();
      const originalKey = key.slice();
      const original = secret.slice();
      const encrypted = await encryptSecret(secret, key, 'inst_1', 7);
      expect(encrypted.keyVersion).toBe(7);
      await expect(decryptSecret(encrypted, key, 'inst_1')).resolves.toEqual(
        secret,
      );
      expect(secret).toEqual(original);
      expect(key).toEqual(originalKey);
    },
  );

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects invalid key version %s',
    async (version) => {
      await expect(
        encryptSecret(encoder.encode('secret'), validKey(), 'inst_1', version),
      ).rejects.toThrow('key version');
    },
  );
});
