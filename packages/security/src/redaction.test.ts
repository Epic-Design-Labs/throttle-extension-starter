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
