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

/** A duration or timestamp in milliseconds. */
export const Ms = z.number().int().nonnegative()
export type Ms = z.infer<typeof Ms>

/** Reference to a vault secret by name, e.g. `{{secrets.acme_staging.password}}`. The value never appears in files. */
export const SECRET_REF = /^\{\{secrets\.([A-Za-z0-9_.-]+)\}\}$/

/** Anything that looks like an attempt at a secret reference (spaces, extra text, newlines…). */
const SECRET_REF_LIKE = /\{\{\s*secrets\b/

/** Returns the secret name if `value` is exactly a secret reference, otherwise undefined. */
export function secretRefName(value: string): string | undefined {
  return SECRET_REF.exec(value)?.[1]
}

/**
 * A value that mentions `{{secrets…` but isn't an exact reference. Rejected at validation time:
 * otherwise the placeholder would be typed literally on camera and never treated as a secret.
 */
export function isMalformedSecretRef(value: string): boolean {
  return SECRET_REF_LIKE.test(value) && secretRefName(value) === undefined
}
