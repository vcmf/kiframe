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

/** Lists of actions whose `type` items may hold a secret reference, by the key that holds them. */
const ACTION_LISTS = new Set(["setup", "steps", "teardown"])

/**
 * Secrets are allowed in exactly one place: the whole `value` of a `type` action, where the runtime
 * resolves it. That means `…/<setup|steps|teardown>/<i>/value` (scenarios, presets) or
 * `interrupts/<i>/do/value`, on an object whose `action` is `type`. Matching the position, not only
 * the shape, keeps free-form objects (e.g. composition `style`) from opening a slot.
 */
function isSecretSlot(path: Path, parent: unknown): boolean {
  const isTypeAction =
    typeof parent === "object" &&
    parent !== null &&
    (parent as { action?: unknown }).action === "type"
  if (!isTypeAction || path[path.length - 1] !== "value") return false
  const [container, index] = [path[path.length - 3], path[path.length - 2]]
  if (typeof index === "number" && typeof container === "string" && ACTION_LISTS.has(container)) {
    return true
  }
  return path[path.length - 2] === "do" && path[path.length - 4] === "interrupts"
}

function walk(value: unknown, path: Path, parent: unknown, issues: z.core.$ZodIssue[]): void {
  const issue = (at: Path, message: string) =>
    issues.push({ code: "custom", path: at, message, input: value })
  if (typeof value === "string") {
    if (isSecretSlot(path, parent)) {
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
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, [...path, i], value, issues))
    return
  }
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        issue([...path, key], `forbidden key "${key}"`)
        continue
      }
      if (mentionsSecret(key)) {
        issue([...path, key], "secret references can't be used as keys")
      }
      walk((value as Record<string, unknown>)[key], [...path, key], value, issues)
    }
  }
}

/**
 * Wraps a top-level schema with the whole-document guards (forbidden keys, secret references).
 * Guard issues and schema issues are reported together, so one pass shows every problem.
 */
export function guarded<T extends z.ZodType>(schema: T) {
  return z.unknown().transform((input, ctx): z.output<T> => {
    const issues: z.core.$ZodIssue[] = []
    walk(input, [], undefined, issues)
    const result = schema.safeParse(input)
    if (!result.success) issues.push(...result.error.issues)
    if (!result.success || issues.length > 0) {
      // Forwarded as custom issues; the original zod code is kept in `params.code`.
      for (const i of issues) {
        ctx.addIssue({
          code: "custom",
          message: i.message,
          path: i.path,
          input,
          params: { code: i.code },
        })
      }
      return z.NEVER
    }
    return result.data
  })
}
