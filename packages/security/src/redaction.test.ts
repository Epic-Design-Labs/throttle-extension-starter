import { describe, expect, it } from 'vitest';

import { redact } from './redaction.js';

describe('structured redaction', () => {
  it('redacts nested sensitive fields', () => {
    expect(
      redact({ authorization: 'Bearer x', nested: { apiKey: 'x', ok: 1 } }),
    ).toEqual({
      authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', ok: 1 },
    });
  });

  it.each([
    'Authorization',
    'API_KEY',
    'token',
    'access-token',
    'refreshToken',
    'secret',
    'signing_secret',
    'webhookSigningSecret',
    'password',
    'credential',
    'credentials',
    'ciphertext',
    'privateKey',
    'cookie',
    'set-cookie',
    'signature',
    'webhookSignature',
    'X-Throttle-Signature',
    'x_throttle_signature',
    'clientSecret',
    'api-token',
    'idToken',
    'x-api-key',
  ])(
    'redacts credential field %s case-insensitively after normalization',
    (field) => {
      expect(redact({ [field]: 'leak' })).toEqual({ [field]: '[REDACTED]' });
    },
  );

  it('does not redact fields merely containing a sensitive substring', () => {
    const safe = {
      monkey: 'banana',
      tokenCount: 2,
      secretariat: 'office',
      cookiesEnabled: true,
    };
    expect(redact(safe)).toEqual(safe);
  });

  it.each(['ownKeys', 'getOwnPropertyDescriptor', 'getPrototypeOf'] as const)(
    'contains hostile proxy %s trap failures without exposing messages',
    (trap) => {
      const handler: ProxyHandler<Record<string, unknown>> = {
        [trap]: () => {
          throw new Error(`hostile ${trap} secret`);
        },
      };
      expect(redact(new Proxy({ safe: 1 }, handler))).toBe('[Unserializable]');
    },
  );

  it('returns an immutable safe clone while preserving arrays and scalar values', () => {
    const input = { list: [{ password: 'x' }, null, true, 2, 'safe'] };
    const result = redact(input);
    expect(result).toEqual({
      list: [{ password: '[REDACTED]' }, null, true, 2, 'safe'],
    });
    expect(result).not.toBe(input);
    expect((result as typeof input).list).not.toBe(input.list);
    expect(input.list[0]).toEqual({ password: 'x' });
  });

  it('safely represents cycles, binary data, dates, and errors', () => {
    const input: Record<string, unknown> = {
      bytes: new Uint8Array([1, 2]),
      date: new Date('2024-01-02T03:04:05.000Z'),
      error: new Error('credential leaked'),
    };
    input.self = input;
    expect(redact(input)).toEqual({
      bytes: '[Binary]',
      date: '2024-01-02T03:04:05.000Z',
      error: { name: 'Error', message: '[REDACTED]' },
      self: '[Circular]',
    });
  });

  it.each([new Uint16Array([1, 2]), new DataView(new ArrayBuffer(4))])(
    'represents every ArrayBuffer view as binary',
    (view) => {
      expect(redact(view)).toBe('[Binary]');
    },
  );

  it('clones arrays from own descriptors without invoking or inheriting getters', () => {
    let calls = 0;
    const input = new Array<unknown>(3);
    Object.defineProperty(input, '0', {
      enumerable: true,
      get: () => {
        calls += 1;
        return 'leak';
      },
    });
    Object.defineProperty(input, '2', { enumerable: true, value: 'safe' });
    Object.setPrototypeOf(input, {
      get 1() {
        calls += 1;
        return 'inherited leak';
      },
    });

    const result = redact(input) as unknown[];

    expect(calls).toBe(0);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe('[Getter]');
    expect(Object.hasOwn(result, 1)).toBe(false);
    expect(result[2]).toBe('safe');
  });

  it('rejects excessive proxied array lengths without allocating the clone', () => {
    const input = new Proxy(new Array(10_001), {});
    expect(redact(input)).toBe('[Unserializable]');
  });

  it('contains malformed proxied array length descriptors', () => {
    const input = new Proxy([], {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'length') {
          return { configurable: true, enumerable: false, value: -1 };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(redact(input)).toBe('[Unserializable]');
  });

  it('rejects proxied array indexes outside the validated source length', () => {
    const input = new Proxy([], {
      ownKeys: () => ['length', '4294967294'],
      getOwnPropertyDescriptor(target, key) {
        if (key === '4294967294') {
          return { configurable: true, enumerable: true, value: 'exotic' };
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    expect(redact(input)).toBe('[Unserializable]');
  });

  it('redacts sensitive named array properties without invoking accessors', () => {
    let calls = 0;
    const input: unknown[] = [];
    Object.defineProperties(input, {
      password: { enumerable: true, value: 'leak' },
      apiKey: {
        enumerable: true,
        get: () => {
          calls += 1;
          return 'leak';
        },
      },
    });

    const result = redact(input) as unknown[] & Record<string, unknown>;

    expect(result.password).toBe('[REDACTED]');
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result).toHaveLength(0);
    expect(calls).toBe(0);
  });

  it('does not invoke getters or toJSON and excludes symbols and non-enumerable values', () => {
    let calls = 0;
    const input = Object.defineProperties(
      {
        safe: 1,
        toJSON: () => {
          calls += 1;
          return { authorization: 'leak' };
        },
      },
      {
        getter: {
          enumerable: true,
          get: () => {
            calls += 1;
            return 'leak';
          },
        },
        hidden: { enumerable: false, value: 'leak' },
        [Symbol('secret')]: { enumerable: true, value: 'leak' },
      },
    );
    expect(redact(input)).toEqual({
      safe: 1,
      toJSON: '[Function]',
      getter: '[Getter]',
    });
    expect(calls).toBe(0);
  });

  it('serializes dates without invoking overridden properties', () => {
    let calls = 0;
    const date = new Date('2024-01-02T03:04:05.000Z');
    Object.defineProperty(date, 'getTime', {
      get: () => {
        calls += 1;
        return () => 0;
      },
    });
    expect(redact(date)).toBe('2024-01-02T03:04:05.000Z');
    expect(calls).toBe(0);
  });

  it('preserves exact safe enumerable field names without prototype pollution', () => {
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, '__proto__', {
      enumerable: true,
      value: 'safe',
    });
    input.constructorName = 'safe';
    const result = redact(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(result.__proto__).toBe('safe');
    expect(result.constructorName).toBe('safe');
  });
});
