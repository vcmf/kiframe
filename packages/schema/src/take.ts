import * as z from "zod"
import {
  NPoint,
  SecretName,
  StepId,
  Timestamp,
  ViewportRect,
  withoutCredentials,
} from "./common.ts"
import { guarded } from "./guards.ts"
import { RuleName, ViewportShape } from "./settings.ts"

// A take = the facts of one replay (docs/OBJECT-MODEL.md §3).
// `t` is milliseconds from the first frame, on the same clock as the screencast frames.

/**
 * `phase` says which part of the scenario produced the event. On-camera events (`steps`) carry the
 * step ID; off-camera work (setup, teardown, presets, interrupts) may not have one.
 */
const base = {
  t: Timestamp,
  phase: z.enum(["setup", "steps", "teardown"]),
  stepId: StepId.optional(),
}

/** A box of a secret region, over its own span. */
const RegionBox = z
  .strictObject({ from: Timestamp, until: Timestamp, rect: ViewportRect })
  .refine((b) => b.until >= b.from, { message: "a box's `until` must not be before its `from`" })

const TakeEventVariants = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.enum(["step_start", "step_end"]) }),
  z.strictObject({
    ...base,
    kind: z.literal("click"),
    /** The click point itself is always inside the viewport. */
    point: NPoint,
    rect: ViewportRect,
    button: z.enum(["left", "right"]),
    /** 2 for a double click. */
    count: z.number().int().min(1).max(3).optional(),
  }),
  z.strictObject({
    ...base,
    kind: z.enum(["type_start", "type_end"]),
    rect: ViewportRect,
    /** Secret NAME only, never its value. */
    secret: SecretName.optional(),
  }),
  z.strictObject({ ...base, kind: z.literal("key"), key: z.string().min(1) }),
  z.strictObject({
    ...base,
    kind: z.literal("scroll"),
    delta: z.strictObject({ x: z.number(), y: z.number() }),
  }),
  /** URL is passed through the secret scrubber before being logged. */
  z.strictObject({
    ...base,
    kind: z.literal("navigate"),
    url: withoutCredentials(z.string()),
  }),
  z.strictObject({ ...base, kind: z.literal("settled") }),
  /** Rect of an element referenced by a `camera.frame` or `emphasis` locator. */
  z.strictObject({
    ...base,
    kind: z.literal("frame_target"),
    ref: z.string().min(1),
    rect: ViewportRect,
  }),
  /**
   * A secret region with its whole time span (SECRETS-DESIGN §5), from `t` to `until`: each box is
   * drawn exactly over its own span (source time, both ends included). The runtime writes the spans
   * (a move's hull, the capture lag after "gone"); the compositor adds no timing of its own.
   */
  z.strictObject({
    ...base,
    kind: z.literal("sensitive"),
    id: z.string().min(1),
    why: z.enum(["secret-field", "secret-text"]),
    until: Timestamp,
    boxes: z.array(RegionBox).min(1),
  }),
  /** An interrupt handled off camera between `t` and `until`: becomes a cut. */
  z.strictObject({ ...base, kind: z.literal("interrupt"), rule: RuleName, until: Timestamp }),
])
/** Unguarded: internal only, use the guarded export. */
const TakeEventBase = TakeEventVariants.refine(
  // Interrupts are handled between steps, so they may have no step even on camera.
  (e) => e.phase !== "steps" || e.kind === "interrupt" || e.stepId !== undefined,
  { message: "on-camera events (phase `steps`) need a stepId", path: ["stepId"] },
)
  .refine((e) => e.kind !== "interrupt" || e.until >= e.t, {
    message: "interrupt `until` must not be before `t`",
    path: ["until"],
  })
  .refine(
    (e) => e.kind !== "sensitive" || e.boxes.every((b) => b.from >= e.t && b.until <= e.until),
    { message: "a region's boxes lie within its span (`t` to `until`)", path: ["boxes"] },
  )
/** A take event, with whole-document guards (forbidden keys, secret references). */
export const TakeEvent = guarded(TakeEventBase)
export type TakeEvent = z.infer<typeof TakeEventBase>

const CursorSampleBase = z.strictObject({
  t: Timestamp,
  p: NPoint,
  pressed: z.boolean(),
  /** Computed CSS `cursor` of the element under the pointer (pointer, text, custom…). */
  css: z.string().optional(),
})
/** A cursor sample, with whole-document guards like every other take record. */
export const CursorSample = guarded(CursorSampleBase)
export type CursorSample = z.infer<typeof CursorSampleBase>

/** Unguarded: internal only, use the guarded export. */
const TakeMetaBase = z.strictObject({
  /** 2: secret regions carry their spans (SECRETS-DESIGN §5); version 1 takes are re-recorded. */
  version: z.literal(2),
  takeKey: z.string().min(1),
  scenarioHash: z.string().min(1),
  recordedAt: z.iso.datetime({ offset: true }),
  appUrl: withoutCredentials(z.string()),
  /** The environment the take was recorded on (APPROACHES §10c), when known. */
  environment: RuleName.optional(),
  /** The page's CSS viewport, and the capture scale actually obtained (frame pixels per CSS pixel). */
  viewport: ViewportShape.extend({ deviceScaleFactor: z.number().gt(0).max(3) }),
  /** Frame size of `frames.webm` in pixels (viewport × DPR). */
  frameSize: z.strictObject({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  fps: z.number().positive(),
  /** On the screencast clock, like event timestamps: may be fractional. */
  durationMs: Timestamp,
  kiframeVersion: z.string(),
  /** How the replay ended: a failed take is kept (for debugging) but must never be used as-is. */
  outcome: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("complete") }),
    z.strictObject({ status: z.literal("failed"), error: z.string() }),
  ]),
})
/** Frame pixels must equal viewport × DPR (±1 for rounding): overlays are placed with it. */
const frameMatchesViewport = (m: z.infer<typeof TakeMetaBase>) =>
  Math.abs(m.frameSize.width - Math.round(m.viewport.width * m.viewport.deviceScaleFactor)) <= 1 &&
  Math.abs(m.frameSize.height - Math.round(m.viewport.height * m.viewport.deviceScaleFactor)) <= 1

export const TakeMeta = guarded(
  TakeMetaBase.refine(frameMatchesViewport, {
    message: "frameSize must equal viewport × deviceScaleFactor",
    path: ["frameSize"],
  }),
)
export type TakeMeta = z.infer<typeof TakeMetaBase>
