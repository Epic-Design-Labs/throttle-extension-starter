export const MAX_CONFIGURATION_DEPTH = 20;
export const MAX_CONFIGURATION_NODES = 10_000;
export type ConfigurationValue =
  | null
  | boolean
  | number
  | string
  | ConfigurationValue[]
  | { [key: string]: ConfigurationValue };
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
export function validateConfigurationValue(
  root: unknown,
): root is ConfigurationValue {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > MAX_CONFIGURATION_NODES || depth > MAX_CONFIGURATION_DEPTH)
      return false;
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'string'
    )
      continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value)
        pending.push({ value: child, depth: depth + 1 });
      continue;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Object.keys(value)) {
      if (dangerous.has(key)) return false;
      pending.push({
        value: (value as Record<string, unknown>)[key],
        depth: depth + 1,
      });
    }
  }
  return true;
}
