import * as z from "zod"
import { Ms, NPoint, NRect, StepId } from "./common.ts"

// The edit: parallel typed tracks of segments (docs/OBJECT-MODEL.md §4).
// Segments are anchored to steps/events in SOURCE time. `clips` maps source → output time.

export const Anchor = z.union([
  z.strictObject({
    step: StepId,
    edge: z.enum(["start", "end"]),
    offsetMs: z.number().int().optional(),
  }),
  z.strictObject({ event: z.string().min(1), offsetMs: z.number().int().optional() }),
  z.strictObject({ scene: z.enum(["start", "end"]), offsetMs: z.number().int().optional() }),
  z.strictObject({ ms: Ms }),
])
export type Anchor = z.infer<typeof Anchor>

const segmentBase = {
  id: z.string().min(1),
  /** Regeneration replaces `auto` segments and keeps `manual` ones. */
  source: z.enum(["auto", "manual"]),
  at: Anchor,
  until: Anchor,
}

export const ClipReason = z.enum(["idle", "network", "setup", "interrupt", "reading", "user"])

export const ClipSegment = z.discriminatedUnion("mode", [
  z.object({
    ...segmentBase,
    mode: z.literal("speed"),
    speed: z.number().positive().max(16),
    reason: ClipReason.optional(),
  }),
  z.object({ ...segmentBase, mode: z.literal("cut"), reason: ClipReason.optional() }),
  /** Hold the source frame at `at` for `ms` of output time (e.g. caption reading time). No `until`. */
  z.object({
    id: segmentBase.id,
    source: segmentBase.source,
    at: Anchor,
    mode: z.literal("freeze"),
    ms: Ms.positive(),
    reason: ClipReason.optional(),
  }),
])
export type ClipSegment = z.infer<typeof ClipSegment>

export const CameraFocus = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("follow-cursor") }),
  z.object({ mode: z.literal("rect"), rect: NRect }),
  z.object({ mode: z.literal("point"), p: NPoint }),
])
export type CameraFocus = z.infer<typeof CameraFocus>

export const CameraSegment = z.object({
  ...segmentBase,
  /** 1 = full frame. Capped at render time by the source resolution (§2b). */
  scale: z.number().min(1).max(4),
  focus: CameraFocus,
  ease: z.enum(["spring", "instant"]).optional(),
})
export type CameraSegment = z.infer<typeof CameraSegment>

export const CaptionSegment = z.object({
  ...segmentBase,
  text: z.string().min(1),
  position: z.enum(["bottom", "top", "near-target"]).optional(),
})
export type CaptionSegment = z.infer<typeof CaptionSegment>

export const MaskSegment = z.object({
  ...segmentBase,
  kind: z.enum(["blur", "pixelate", "highlight", "spotlight"]),
  target: z.union([
    z.strictObject({ sensitiveId: z.string().min(1) }),
    z.strictObject({ frameRef: z.string().min(1) }),
    z.strictObject({ rect: NRect }),
  ]),
})
export type MaskSegment = z.infer<typeof MaskSegment>

export const CursorSegment = z.object({
  ...segmentBase,
  kind: z.enum(["hidden", "click-ripple"]),
})
export type CursorSegment = z.infer<typeof CursorSegment>

export const Composition = z.object({
  version: z.literal(1),
  /** The take the auto segments were generated from. */
  take: z.object({ key: z.string().min(1) }).optional(),
  tracks: z.object({
    clips: z.array(ClipSegment).default([]),
    camera: z.array(CameraSegment).default([]),
    cursor: z.array(CursorSegment).default([]),
    captions: z.array(CaptionSegment).default([]),
    masks: z.array(MaskSegment).default([]),
  }),
})
export type Composition = z.infer<typeof Composition>
