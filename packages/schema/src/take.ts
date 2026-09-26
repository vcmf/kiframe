import * as z from "zod"
import { Ms, NPoint, NRect, StepId } from "./common.ts"

// A take = the facts of one replay (docs/OBJECT-MODEL.md §3).
// `t` is milliseconds from the first frame, on the same clock as the screencast frames.

const base = { t: Ms, stepId: StepId }

export const TakeEvent = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.enum(["step_start", "step_end"]) }),
  z.object({
    ...base,
    kind: z.literal("click"),
    point: NPoint,
    rect: NRect,
    button: z.enum(["left", "right"]),
  }),
  z.object({
    ...base,
    kind: z.enum(["type_start", "type_end"]),
    rect: NRect,
    /** Secret NAME only, never its value. */
    secret: z.string().optional(),
  }),
  z.object({ ...base, kind: z.literal("key"), key: z.string().min(1) }),
  z.object({
    ...base,
    kind: z.literal("scroll"),
    delta: z.object({ x: z.number(), y: z.number() }),
  }),
  /** URL is passed through the secret scrubber before being logged. */
  z.object({ ...base, kind: z.literal("navigate"), url: z.string() }),
  z.object({ ...base, kind: z.literal("settled") }),
  /** Rect of an element referenced by a `camera.frame` or `emphasis` locator. */
  z.object({ ...base, kind: z.literal("frame_target"), ref: z.string().min(1), rect: NRect }),
  /** Re-logged whenever the element moves. */
  z.object({
    ...base,
    kind: z.literal("sensitive"),
    id: z.string().min(1),
    rect: NRect,
    why: z.enum(["secret-field", "secret-text", "redaction"]),
  }),
  /** An interrupt handled off camera between `t` and `until`: becomes a cut. */
  z.object({ ...base, kind: z.literal("interrupt"), rule: z.string().min(1), until: Ms }),
])
export type TakeEvent = z.infer<typeof TakeEvent>

export const CursorSample = z.object({
  t: Ms,
  p: NPoint,
  pressed: z.boolean(),
  /** Computed CSS `cursor` of the element under the pointer (pointer, text, custom…). */
  css: z.string().optional(),
})
export type CursorSample = z.infer<typeof CursorSample>

export const TakeMeta = z.object({
  version: z.literal(1),
  takeKey: z.string().min(1),
  scenarioHash: z.string().min(1),
  recordedAt: z.iso.datetime(),
  appUrl: z.string(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive(),
  }),
  /** Frame size of `frames.webm` in pixels (viewport × DPR). */
  frameSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  fps: z.number().positive(),
  durationMs: Ms,
  kiframeVersion: z.string(),
})
export type TakeMeta = z.infer<typeof TakeMeta>
