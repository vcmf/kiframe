import * as z from "zod"
import { Ms, NPoint, StepId, ViewportRect } from "./common.ts"
import { Viewport } from "./settings.ts"

// A take = the facts of one replay (docs/OBJECT-MODEL.md §3).
// `t` is milliseconds from the first frame, on the same clock as the screencast frames.

/**
 * `phase` says which part of the scenario produced the event. On-camera events (`steps`) carry the
 * step ID; off-camera work (setup, teardown, presets, interrupts) may not have one.
 */
const base = {
  t: Ms,
  phase: z.enum(["setup", "steps", "teardown"]),
  stepId: StepId.optional(),
}

const TakeEventVariants = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.enum(["step_start", "step_end"]) }),
  z.strictObject({
    ...base,
    kind: z.literal("click"),
    /** The click point itself is always inside the viewport. */
    point: NPoint,
    rect: ViewportRect,
    button: z.enum(["left", "right"]),
  }),
  z.strictObject({
    ...base,
    kind: z.enum(["type_start", "type_end"]),
    rect: ViewportRect,
    /** Secret NAME only, never its value. */
    secret: z.string().optional(),
  }),
  z.strictObject({ ...base, kind: z.literal("key"), key: z.string().min(1) }),
  z.strictObject({
    ...base,
    kind: z.literal("scroll"),
    delta: z.strictObject({ x: z.number(), y: z.number() }),
  }),
  /** URL is passed through the secret scrubber before being logged. */
  z.strictObject({ ...base, kind: z.literal("navigate"), url: z.string() }),
  z.strictObject({ ...base, kind: z.literal("settled") }),
  /** Rect of an element referenced by a `camera.frame` or `emphasis` locator. */
  z.strictObject({
    ...base,
    kind: z.literal("frame_target"),
    ref: z.string().min(1),
    rect: ViewportRect,
  }),
  /** Re-logged whenever the element moves. */
  z.strictObject({
    ...base,
    kind: z.literal("sensitive"),
    id: z.string().min(1),
    rect: ViewportRect,
    why: z.enum(["secret-field", "secret-text", "redaction"]),
  }),
  /** An interrupt handled off camera between `t` and `until`: becomes a cut. */
  z.strictObject({ ...base, kind: z.literal("interrupt"), rule: z.string().min(1), until: Ms }),
])
export const TakeEvent = TakeEventVariants.refine(
  // Interrupts are handled between steps, so they may have no step even on camera.
  (e) => e.phase !== "steps" || e.kind === "interrupt" || e.stepId !== undefined,
  { message: "on-camera events (phase `steps`) need a stepId", path: ["stepId"] },
).refine((e) => e.kind !== "interrupt" || e.until >= e.t, {
  message: "interrupt `until` must not be before `t`",
  path: ["until"],
})
export type TakeEvent = z.infer<typeof TakeEvent>

export const CursorSample = z.strictObject({
  t: Ms,
  p: NPoint,
  pressed: z.boolean(),
  /** Computed CSS `cursor` of the element under the pointer (pointer, text, custom…). */
  css: z.string().optional(),
})
export type CursorSample = z.infer<typeof CursorSample>

export const TakeMeta = z.strictObject({
  version: z.literal(1),
  takeKey: z.string().min(1),
  scenarioHash: z.string().min(1),
  recordedAt: z.iso.datetime({ offset: true }),
  appUrl: z.string(),
  viewport: Viewport.required(),
  /** Frame size of `frames.webm` in pixels (viewport × DPR). */
  frameSize: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  fps: z.number().positive(),
  durationMs: Ms,
  kiframeVersion: z.string(),
})
export type TakeMeta = z.infer<typeof TakeMeta>
