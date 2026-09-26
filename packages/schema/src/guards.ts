import * as z from "zod"
import { isMalformedSecretRef, mentionsSecret } from "./common.ts"

// Whole-document guards, applied once to the raw input of every top-level schema (scenario,
// project config, composition, take events and metadata). Doing it in one pass, instead of one
// refinement per string field, means a new field can't forget the rule.

/** Keys that would change an object's prototype instead of creating a property. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
])

type Path = (string | number)[]

/**
 * Secrets are allowed in exactly one place: the whole `value` of a `type` action, where the runtime
 * resolves them. Anywhere else a reference would be shown, logged or injected literally.
 */
function isSecretSlot(parent: unknown, key: string | number): boolean {
  return (
    key === "value" &&
    typeof parent === "object" &&
    parent !== null &&
    (parent as { action?: unknown }).action === "type"
  )
}

function walk(value: unknown, path: Path, parent: unknown, ctx: z.RefinementCtx): void {
  if (typeof value === "string") {
    const key = path[path.length - 1]
    if (key !== undefined && isSecretSlot(parent, key)) {
      if (isMalformedSecretRef(value)) {
        ctx.addIssue({
          code: "custom",
          path,
          message:
            "malformed secret reference: use exactly `{{secrets.<name>}}`, with no spaces or other text",
        })
      }
    } else if (mentionsSecret(value)) {
      ctx.addIssue({
        code: "custom",
        path,
        message: "secret references are only allowed as the whole `value` of a `type` action",
      })
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, [...path, i], value, ctx))
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        ctx.addIssue({ code: "custom", path: [...path, key], message: `forbidden key "${key}"` })
        continue
      }
      walk((value as Record<string, unknown>)[key], [...path, key], value, ctx)
    }
  }
}

/** Wraps a top-level schema with the whole-document guards (forbidden keys, secret references). */
export function guarded<T extends z.ZodType>(schema: T) {
  return z.preprocess((input, ctx) => {
    walk(input, [], undefined, ctx)
    return input
  }, schema)
}
