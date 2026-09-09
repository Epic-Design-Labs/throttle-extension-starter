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

/**
 * The delivered envelope. Throttle adds top-level fields without bumping
 * `version` (it did so with `environmentKind` on 2026-09-08), so this schema
 * must strip unknown keys rather than reject them: a `.strict()` envelope
 * turned that additive field into a 401 on every delivery, hours after the
 * HMAC had already matched. Only a `version` change is a breaking change.
 */
export const throttleEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  /** Payload-schema version stamped on every delivered envelope (currently '1'). */
  version: z.string().min(1),
  workspaceId: z.string().min(1),
  environmentId: z.string().min(1),
  /**
   * `production` | `non_production`. Absent on deliveries made before the
   * field shipped, and reduced to absent for any value this build does not
   * know, so "unknown" never masquerades as either kind.
   */
  environmentKind: z
    .enum(['production', 'non_production'])
    .optional()
    .catch(undefined),
  createdAt: z.iso.datetime(),
  data: safeJsonObjectSchema,
});

export type ThrottleEvent = z.infer<typeof throttleEventSchema>;
