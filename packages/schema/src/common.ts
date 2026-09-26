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

/** Pattern of a secret NAME: dotted segments of letters, digits, `_` and `-`. */
const SECRET_NAME = "[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*"

/** A secret NAME, e.g. `acme_staging.password`. Never a secret value. */
export const SecretName = z
  .string()
  .regex(new RegExp(`^${SECRET_NAME}$`), "must be a secret name, never a secret value")
export type SecretName = z.infer<typeof SecretName>

/** Reference to a vault secret by name, e.g. `{{secrets.acme_staging.password}}`. The value never appears in files. */
export const SECRET_REF = new RegExp(`^\\{\\{secrets\\.(${SECRET_NAME})\\}\\}$`)

/**
 * An attempt at a secret reference: `{{secret.` / `{{ Secrets.` … (any case or spacing, then a dot).
 * The dot keeps ordinary template text like `{{ secretary }}` or `{{secret_key}}` from matching.
 */
const SECRET_REF_LIKE = /\{\{\s*secrets?\s*\./i

/** Returns the secret name if `value` is exactly a secret reference, otherwise undefined. */
export function secretRefName(value: string): string | undefined {
  return SECRET_REF.exec(value)?.[1]
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
 * A URL relative to the environment: a path (`/projects`) or query (`?tab=1`), never a scheme
 * (`https:`, `javascript:`, `http:host`…) or protocol-relative (`//host`), so `goto` can't leave the
 * target app (e.g. to type a secret on another origin).
 */
export function isRelativeUrl(url: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[/\\]{2}/.test(url)
}

/** Adds the "no embedded credentials" rule to a URL-ish string schema (one rule for every URL field). */
export function withoutCredentials<T extends z.ZodType<string>>(schema: T) {
  return schema.refine((u) => !hasUrlCredentials(u), {
    message: "URL must not contain credentials: store them in the vault",
  })
}

/** Quotes are balanced (an unterminated string would swallow the rest of the stylesheet). */
function balancedQuotes(selector: string): boolean {
  let quote: string | undefined
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]
    if (c === "\\") {
      i++
      continue
    }
    if (quote === undefined && (c === '"' || c === "'")) quote = c
    else if (c === quote) quote = undefined
  }
  return quote === undefined
}

/**
 * A CSS selector Kiframe injects into the page (`hide`, redaction) or queries with. Anything that
 * could escape the rule it's placed in is rejected: braces, semicolons, at-rules, comments, `<`
 * (e.g. `</style>`) and unterminated strings.
 */
export const CssSelector = z
  .string()
  .min(1)
  .max(500)
  .refine((s) => !/[{};@<]|\/\*|\*\//.test(s) && balancedQuotes(s), {
    message: "must be a single CSS selector (no `{`, `}`, `;`, `@`, `<`, comments or open quotes)",
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
