const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'apikey',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'signingsecret',
  'webhooksigningsecret',
  'password',
  'credential',
  'credentials',
  'ciphertext',
  'privatekey',
  'cookie',
  'setcookie',
]);

const isSensitiveKey = (key: string): boolean =>
  SENSITIVE_KEYS.has(key.toLowerCase().replace(/[-_\s]/gu, ''));

const errorName = (error: Error): string => {
  const descriptor = Object.getOwnPropertyDescriptor(error, 'name');
  return descriptor &&
    'value' in descriptor &&
    typeof descriptor.value === 'string'
    ? descriptor.value
    : 'Error';
};

const cloneForLogging = (
  value: unknown,
  ancestors: WeakSet<object>,
): unknown => {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return undefined;
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return undefined;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return '[Binary]';
  if (value instanceof Date) {
    const timestamp = Date.prototype.getTime.call(value) as number;
    return Number.isNaN(timestamp)
      ? '[Invalid Date]'
      : new Date(timestamp).toISOString();
  }
  if (value instanceof Error)
    return { name: errorName(value), message: REDACTED };
  if (typeof value !== 'object') return String(value);
  if (ancestors.has(value)) return '[Circular]';

  ancestors.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const lengthDescriptor = descriptors.length;
    const length =
      lengthDescriptor && 'value' in lengthDescriptor
        ? (lengthDescriptor.value as number)
        : 0;
    const result = new Array<unknown>(length);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'length' || !descriptor.enumerable) continue;
      const sanitized =
        'value' in descriptor
          ? cloneForLogging(descriptor.value, ancestors)
          : '[Getter]';
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: sanitized,
      });
    }
    ancestors.delete(value);
    return result;
  }

  const result: Record<string, unknown> =
    Object.getPrototypeOf(value) === null
      ? (Object.create(null) as Record<string, unknown>)
      : {};
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable) continue;
    const sanitized = isSensitiveKey(key)
      ? REDACTED
      : 'value' in descriptor
        ? cloneForLogging(descriptor.value, ancestors)
        : '[Getter]';
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: sanitized,
    });
  }
  ancestors.delete(value);
  return result;
};

/** Creates a getter-free, JSON-friendly clone suitable for structured logs. */
export function redact<T>(value: T): unknown {
  return cloneForLogging(value, new WeakSet());
}
