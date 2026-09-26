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

/** Maximum nesting depth of a document. Real files are far shallower; this stops runaway input. */
const MAX_DEPTH = 64

type Path = (string | number)[]

/**
 * Where a secret reference may appear, as a path from the document root. The segment `"#"` matches
 * any array index and `"*"` any object key; other segments match literally. The value at the slot
 * must also be the `value` of a `type` action.
 */
export type SecretSlot = readonly string[]

function matchesSlot(path: Path, slot: SecretSlot): boolean {
  if (path.length !== slot.length) return false
  return slot.every((part, i) => {
    const actual = path[i]
    if (part === "#") return typeof actual === "number"
    if (part === "*") return typeof actual === "string"
    return actual === part
  })
}

function isTypeAction(parent: unknown): boolean {
  return (
    typeof parent === "object" &&
    parent !== null &&
    (parent as { action?: unknown }).action === "type"
  )
}

interface Walk {
  slots: readonly SecretSlot[]
  issues: z.core.$ZodIssue[]
  ancestors: WeakSet<object>
  structural: boolean
}

function walk(value: unknown, path: Path, parent: unknown, w: Walk): void {
  const issue = (at: Path, message: string) =>
    w.issues.push({ code: "custom", path: at, message, input: value })
  if (typeof value === "string") {
    const isSlot = isTypeAction(parent) && w.slots.some((slot) => matchesSlot(path, slot))
    if (isSlot) {
      if (isMalformedSecretRef(value)) {
        issue(
          path,
          "malformed secret reference: use exactly `{{secrets.<name>}}`, with no spaces or other text",
        )
      }
    } else if (mentionsSecret(value)) {
      issue(path, "secret references are only allowed as the whole `value` of a `type` action")
    }
    return
  }
  if (typeof value !== "object" || value === null) return
  if (path.length > MAX_DEPTH) {
    w.structural = true
    issue(path, `document is nested too deeply (more than ${MAX_DEPTH} levels)`)
    return
  }
  if (w.ancestors.has(value)) {
    w.structural = true
    issue(path, "document contains a cycle (a YAML alias refers to one of its own parents)")
    return
  }
  w.ancestors.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, [...path, i], value, w))
  } else {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        issue([...path, key], `forbidden key "${key}"`)
        continue
      }
      if (mentionsSecret(key)) issue([...path, key], "secret references can't be used as keys")
      walk((value as Record<string, unknown>)[key], [...path, key], value, w)
    }
  }
  w.ancestors.delete(value)
}

/**
 * Wraps a top-level schema with the whole-document guards: forbidden keys, cycles and depth, and
 * secret references outside the given `slots`. Guard issues and schema issues are reported together,
 * so one pass shows every problem. The schema only runs on a well-formed (acyclic, bounded) document.
 */
export function guarded<T extends z.ZodType>(schema: T, slots: readonly SecretSlot[] = []) {
  return z.unknown().transform((input, ctx): z.output<T> => {
    const w: Walk = { slots, issues: [], ancestors: new WeakSet(), structural: false }
    walk(input, [], undefined, w)
    const result = w.structural ? undefined : schema.safeParse(input)
    if (result && !result.success) w.issues.push(...result.error.issues)
    if (result === undefined || !result.success || w.issues.length > 0) {
      // Keep zod's own issues as they are (code, keys, union errors…), not flattened to "custom".
      ctx.issues.push(...(w.issues.map((i) => ({ ...i, input })) as typeof ctx.issues))
      return z.NEVER
    }
    return result.data
  })
}
