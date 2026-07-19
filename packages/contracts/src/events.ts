import { z } from 'zod';

const dangerousObjectKeys = new Set(['__proto__', 'prototype', 'constructor']);

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function containsDangerousKey(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Object.keys(value).some((key) => dangerousObjectKeys.has(key)))
    return true;

  return Object.values(value).some((nestedValue) =>
    containsDangerousKey(nestedValue, seen),
  );
}

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    safeJsonObjectSchema,
  ]),
);

const safeJsonObjectSchema: z.ZodType<{ [key: string]: JsonValue }> =
  z.preprocess(
    (value, ctx) => {
      if (containsDangerousKey(value)) {
        ctx.issues.push({
          code: 'custom',
          input: value,
          message: 'Object payload contains a prototype-dangerous key',
        });
        return z.NEVER;
      }

      return value;
    },
    z.record(z.string(), jsonValueSchema),
  );

export const throttleEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    workspaceId: z.string().min(1),
    environmentId: z.string().min(1),
    createdAt: z.iso.datetime(),
    data: safeJsonObjectSchema,
  })
  .strict();

export type ThrottleEvent = z.infer<typeof throttleEventSchema>;
