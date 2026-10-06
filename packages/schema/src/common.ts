import * as z from "zod"

/** A value normalized to the viewport: 0 = left/top edge, 1 = right/bottom edge. */
const unit = z.number().min(0).max(1)
/** A normalized size: strictly positive (zero-area rects make scale-to-fit divide by zero). */
const size = z.number().gt(0).max(1)

/** Tolerance for rects that touch the viewport edge after float rounding. */
const EDGE_EPSILON = 1e-6

const fitsViewport = (x: number, y: number, w: number, h: number) =>
  x + w <= 1 + EDGE_EPSILON && y + h <= 1 + EDGE_EPSILON
const fitsMessage = { message: "rect must fit inside the viewport (x + w <= 1 and y + h <= 1)" }

/** A point normalized 0..1 relative to the viewport (resolution independent). */
export const NPoint = z.strictObject({ x: unit, y: unit })
export type NPoint = z.infer<typeof NPoint>

/** A rectangle normalized 0..1 relative to the viewport. Non-empty, inside the viewport. */
export const NRect = z
  .strictObject({ x: unit, y: unit, w: size, h: size })
  .refine((r) => fitsViewport(r.x, r.y, r.w, r.h), fitsMessage)
export type NRect = z.infer<typeof NRect>

/**
 * A rect as observed in the page, normalized to the viewport but NOT clipped to it: an element can
 * be partly or fully off screen, or collapsed to zero size. Takes record these as-is (a sensitive
 * field half scrolled out of view must still be masked); the renderer clips to the frame.
 */
export const ViewportRect = z.strictObject({
  x: z.number(),
  y: z.number(),
  w: z.number().nonnegative(),
  h: z.number().nonnegative(),
})
export type ViewportRect = z.infer<typeof ViewportRect>

/** The smallest rect holding both (any `{x, y, w, h}` rects in one space). */
export function rectUnion<R extends { x: number; y: number; w: number; h: number }>(
  p: R,
  q: R,
): { x: number; y: number; w: number; h: number } {
  const x = Math.min(p.x, q.x)
  const y = Math.min(p.y, q.y)
  return { x, y, w: Math.max(p.x + p.w, q.x + q.w) - x, h: Math.max(p.y + p.h, q.y + q.h) - y }
}

/** A normalized rect written as `[x, y, w, h]` (author-facing form used in scenarios). */
export const RectTuple = z
  .tuple([unit, unit, size, size])
  .refine(([x, y, w, h]) => fitsViewport(x, y, w, h), fitsMessage)
export type RectTuple = z.infer<typeof RectTuple>

/** Stable step ID: everything downstream (takes, compositions) anchors to it. Kebab-case. */
export const StepId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, "step id must be kebab-case (a-z, 0-9, -)")
export type StepId = z.infer<typeof StepId>

/** A duration or authored time in milliseconds (integer). */
export const Ms = z.number().int().nonnegative()
export type Ms = z.infer<typeof Ms>

/** A recorded timestamp in milliseconds. Fractional: screencast frame timestamps are floats. */
export const Timestamp = z.number().nonnegative()
export type Timestamp = z.infer<typeof Timestamp>

/** Keys that would change an object's prototype instead of creating a property. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
])

/** Pattern of a secret NAME: dotted segments of letters, digits, `_` and `-`. */
const SECRET_NAME = "[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*"

/** A secret NAME, e.g. `acme_staging.password`. Never a secret value. */
export const SecretName = z
  .string()
  .regex(new RegExp(`^${SECRET_NAME}$`), "must be a secret name, never a secret value")
  .refine((name) => !name.split(".").some((segment) => FORBIDDEN_KEYS.has(segment)), {
    message: "reserved segment in secret name (it clashes with JavaScript object keys)",
  })
export type SecretName = z.infer<typeof SecretName>

/** Reference to a vault secret by name, e.g. `{{secrets.acme_staging.password}}`. The value never appears in files. */
export const SECRET_REF = new RegExp(`^\\{\\{secrets\\.(${SECRET_NAME})\\}\\}$`)

/**
 * An attempt at a secret reference: `{{secret.` / `{{ Secrets.` … (any case or spacing, then a dot).
 * The dot keeps ordinary template text like `{{ secretary }}` or `{{secret_key}}` from matching.
 */
const SECRET_REF_LIKE = /\{\{\s*secrets?\s*\./i

/** Returns the secret name if `value` is exactly a well-formed secret reference, otherwise undefined. */
export function secretRefName(value: string): string | undefined {
  const name = SECRET_REF.exec(value)?.[1]
  return name !== undefined && SecretName.safeParse(name).success ? name : undefined
}

/** True if `value` mentions a secret reference in any form (exact or malformed). */
export function mentionsSecret(value: string): boolean {
  return SECRET_REF_LIKE.test(value)
}

/** A value that mentions `{{secrets…` but isn't an exact reference. */
export function isMalformedSecretRef(value: string): boolean {
  return mentionsSecret(value) && secretRefName(value) === undefined
}

// ─── URLs ─────────────────────────────────────────────────────────────────────

/** Credentials `url` would carry once resolved against `base` (empty if none or unparseable). */
function credentialsAgainst(url: string, base: string): string {
  const parsed = URL.parse(url, base)
  return parsed === null ? "" : parsed.username + parsed.password
}

/**
 * True if `url` embeds credentials once resolved, whatever the app's scheme. Checked against both
 * an http and an https base: `http:u:p@host` looks like a path on an http base but resolves to a
 * credentialed URL on another host against an https app. Also catches `//user:pass@host`.
 */
export function hasUrlCredentials(url: string): boolean {
  return (
    credentialsAgainst(url, "http://base.invalid") !== "" ||
    credentialsAgainst(url, "https://base.invalid") !== ""
  )
}

/**
 * A URL relative to the app: once resolved, it must stay on the app's origin.
 * Resolving (instead of pattern-matching the string) follows the WHATWG parser exactly, which strips
 * leading spaces and control characters and ignores tabs/newlines anywhere: `" https://evil.com"`,
 * `"h\\nttps://evil.com"` or `"/\\t/evil.com"` all resolve off-origin and are rejected, like
 * `https:`, `javascript:`, `http:host` and `//host`.
 */
export function isRelativeUrl(url: string): boolean {
  // Two bases with different hosts: a URL naming one base's host (`//a.invalid/x`) still leaves the other.
  return ["http://a.invalid", "https://b.invalid"].every(
    (base) => URL.parse(url, base)?.origin === base,
  )
}

/** Adds the "no embedded credentials" rule to a URL-ish string schema (one rule for every URL field). */
export function withoutCredentials<T extends z.ZodType<string>>(schema: T) {
  return schema.refine((u) => !hasUrlCredentials(u), {
    message: "URL must not contain credentials: store them in the vault",
  })
}

/**
 * A file path inside the scene folder (e.g. `fp/open-new.png`): relative, forward slashes, no `..`
 * segment, no scheme. The runtime reads these files and may show them to the model, so a path must
 * never reach outside the scene.
 */
export const SceneFilePath = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/, {
    message: "must be a relative path inside the scene (no leading `/`, `\\`, `:` or `..`)",
  })

/**
 * Checks a selector can't escape the rule it's injected into: quotes closed, `()` and `[]` balanced
 * and properly nested, no trailing backslash, and outside strings none of `{ } ; @ <` or comments.
 */
function isSelfContainedSelector(selector: string): boolean {
  const closing: Record<string, string> = { "(": ")", "[": "]" }
  const stack: string[] = []
  let quote: string | undefined
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i] ?? ""
    // `<` is rejected everywhere, even quoted or escaped: an HTML tokenizer ignores CSS quoting
    // and escapes, so `</style>` would still close a <style> element the selector is injected into.
    if (c === "<") return false
    if (c === "\\") {
      if (i === selector.length - 1) return false // a trailing backslash escapes the rule's `{`
      i++
      continue
    }

    if (quote !== undefined) {
      // An unescaped newline ends a CSS string early ("bad string"): what follows is real syntax.
      if (c === "\n" || c === "\r" || c === "\f") return false
      if (c === quote) quote = undefined
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c in closing) stack.push(closing[c] ?? "")
    else if (c === ")" || c === "]") {
      if (stack.pop() !== c) return false
    } else if ("{};@<".includes(c)) return false
    else if (c === "/" && selector[i + 1] === "*") return false
    else if (c === "*" && selector[i + 1] === "/") return false
  }
  return quote === undefined && stack.length === 0
}

export const CssSelector = z.string().min(1).max(500).refine(isSelfContainedSelector, {
  message:
    "must be a single CSS selector (balanced quotes and brackets; no `{`, `}`, `;`, `@`, `<`, comments or trailing `\\`)",
})

/** The `id` of an item, if it has a string one (steps, actions, rules, segments). */
export function idOf(item: object): string | undefined {
  return "id" in item && typeof item.id === "string" ? item.id : undefined
}

/** The ids of the items that have one, in order. */
export function idsOf(items: readonly object[]): string[] {
  return items.flatMap((item) => {
    const id = idOf(item)
    return id === undefined ? [] : [id]
  })
}

/**
 * Registers the ids of `items` in `claims` (id → section where it was first seen) and reports
 * duplicates, both within `items` and against ids already claimed by other sections.
 */
export function claimIds(
  items: readonly object[] | undefined,
  section: (string | number)[],
  ctx: z.RefinementCtx,
  claims: Map<string, string> = new Map(),
): Map<string, string> {
  items?.forEach((item, i) => {
    const id = idOf(item)
    if (id === undefined) return
    const previous = claims.get(id)
    if (previous !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate id "${id}" (already used in ${previous})`,
        path: [...section, i, "id"],
      })
    } else {
      claims.set(id, [...section, i].join("."))
    }
  })
  return claims
}

/** Server-issued ids (orgs, projects). */
export const ServerId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "an id is 1-64 of A-Z a-z 0-9 _ -")
export const OrgId = ServerId
export type OrgId = z.infer<typeof OrgId>
export const ProjectId = ServerId
export type ProjectId = z.infer<typeof ProjectId>
