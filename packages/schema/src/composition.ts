import * as z from "zod"
import { claimIds, Ms, NPoint, NRect, StepId } from "./common.ts"
import { guarded } from "./guards.ts"
import { CAMERA_SCALE, MAX_SPEED } from "./settings.ts"

// The edit: parallel typed tracks of segments (docs/OBJECT-MODEL.md §4).
// Segments are anchored to steps/events in SOURCE time. `clips` maps source → output time.

export const Anchor = z.union([
  z.strictObject({
    step: StepId,
    edge: z.enum(["start", "end"]),
    offsetMs: z.number().int().optional(),
  }),
  z.strictObject({ event: z.string().min(1), offsetMs: z.number().int().optional() }),
  // Scene anchors stay inside the scene: offsets go forward from the start, backward from the end.
  z.strictObject({
    scene: z.literal("start"),
    offsetMs: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({ scene: z.literal("end"), offsetMs: z.number().int().nonpositive().optional() }),
  z.strictObject({ ms: Ms }),
])
export type Anchor = z.infer<typeof Anchor>

/**
 * True when `a` is at or before `b` whatever the take: both absolute (`{ms}` or the scene start),
 * or on the same step/scene/event with `a` no later on both the edge and the offset (a start is
 * never after its end). False means "not provably": only a take can tell.
 */
export function isCertainlyNotAfter(a: Anchor, b: Anchor): boolean {
  const edge = (e: "start" | "end") => (e === "start" ? 0 : 1)
  const offset = (x: { offsetMs?: number | undefined }) => x.offsetMs ?? 0
  const absolute = (x: Anchor): number | undefined => {
    if ("ms" in x) return x.ms
    if ("scene" in x && x.scene === "start") return offset(x)
    return undefined
  }
  const absA = absolute(a)
  const absB = absolute(b)
  // Anchors are clamped to the scene: time 0 is at or before anything, the scene end at or after.
  if (absA === 0) return true
  if ("scene" in b && b.scene === "end" && offset(b) === 0) return true
  if (absA !== undefined && absB !== undefined) return absA <= absB
  if ("scene" in a && "scene" in b) {
    return edge(a.scene) <= edge(b.scene) && offset(a) <= offset(b)
  }
  if ("step" in a && "step" in b && a.step === b.step) {
    return edge(a.edge) <= edge(b.edge) && offset(a) <= offset(b)
  }
  if ("event" in a && "event" in b && a.event === b.event) return offset(a) <= offset(b)
  return false
}

const segmentBase = {
  id: z.string().min(1),
  /** Regeneration replaces `auto` segments and keeps `manual` ones. */
  source: z.enum(["auto", "manual"]),
  at: Anchor,
  until: Anchor,
}

export const ClipReason = z.enum(["idle", "network", "setup", "interrupt", "reading", "user"])

export const ClipSegment = z.discriminatedUnion("mode", [
  z.strictObject({
    ...segmentBase,
    mode: z.literal("speed"),
    speed: z.number().positive().max(MAX_SPEED),
    reason: ClipReason.optional(),
  }),
  z.strictObject({ ...segmentBase, mode: z.literal("cut"), reason: ClipReason.optional() }),
  /** Hold the source frame at `at` for `ms` of output time (e.g. caption reading time). No `until`. */
  z.strictObject({
    id: segmentBase.id,
    source: segmentBase.source,
    at: Anchor,
    mode: z.literal("freeze"),
    ms: Ms.positive(),
    reason: z.enum(["reading", "user"]).optional(),
  }),
])
export type ClipSegment = z.infer<typeof ClipSegment>

export const CameraFocus = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("follow-cursor") }),
  z.strictObject({ mode: z.literal("rect"), rect: NRect }),
  z.strictObject({ mode: z.literal("point"), p: NPoint }),
])
export type CameraFocus = z.infer<typeof CameraFocus>

export const CameraSegment = z.strictObject({
  ...segmentBase,
  /** 1 = full frame. Capped at render time by the source resolution (§2b). */
  scale: z.number().min(CAMERA_SCALE.min).max(CAMERA_SCALE.max),
  focus: CameraFocus,
  ease: z.enum(["spring", "instant"]).optional(),
})
export type CameraSegment = z.infer<typeof CameraSegment>

export const CaptionSegment = z.strictObject({
  ...segmentBase,
  text: z.string().min(1),
  position: z.enum(["bottom", "top", "near-target"]).optional(),
})
export type CaptionSegment = z.infer<typeof CaptionSegment>

export const MaskSegment = z.strictObject({
  ...segmentBase,
  kind: z.enum(["blur", "pixelate", "highlight", "spotlight"]),
  target: z.union([
    z.strictObject({ sensitiveId: z.string().min(1) }),
    z.strictObject({ frameRef: z.string().min(1) }),
    z.strictObject({ rect: NRect }),
  ]),
})
export type MaskSegment = z.infer<typeof MaskSegment>

export const CursorSegment = z.strictObject({
  ...segmentBase,
  kind: z.enum(["hidden", "click-ripple"]),
})
export type CursorSegment = z.infer<typeof CursorSegment>

const calloutTarget = z.union([
  z.strictObject({ frameRef: z.string().min(1) }),
  z.strictObject({ rect: NRect }),
])

/** A text callout needs its text; arrows and badges may have an optional label. */
export const CalloutSegment = z.discriminatedUnion("kind", [
  z.strictObject({
    ...segmentBase,
    kind: z.literal("text"),
    text: z.string().min(1),
    target: calloutTarget,
  }),
  z.strictObject({
    ...segmentBase,
    kind: z.enum(["arrow", "badge"]),
    text: z.string().min(1).optional(),
    target: calloutTarget,
  }),
])
export type CalloutSegment = z.infer<typeof CalloutSegment>

export const KeystrokeSegment = z.strictObject({ ...segmentBase, keys: z.string().min(1) })
export type KeystrokeSegment = z.infer<typeof KeystrokeSegment>

/** Unguarded: internal only, use the guarded export. */
const CompositionBase = z
  .strictObject({
    version: z.literal(1),
    /** The take the auto segments were generated from. */
    take: z.strictObject({ key: z.string().min(1) }).optional(),
    /** Scene-level style overrides. Typed with the compositor (P0-7); kept verbatim until then. */
    style: z.record(z.string(), z.unknown()).optional(),
    tracks: z.strictObject({
      clips: z.array(ClipSegment).default([]),
      camera: z.array(CameraSegment).default([]),
      cursor: z.array(CursorSegment).default([]),
      captions: z.array(CaptionSegment).default([]),
      masks: z.array(MaskSegment).default([]),
      callouts: z.array(CalloutSegment).default([]),
      keystrokes: z.array(KeystrokeSegment).default([]),
    }),
  })
  .superRefine((c, ctx) => {
    // Segment ids are unique across all tracks: regeneration keeps manual segments by id.
    const claims = new Map<string, string>()
    for (const [track, segments] of Object.entries(c.tracks)) {
      claimIds(segments, ["tracks", track], ctx, claims)
      segments.forEach((segment: { at: Anchor; until?: Anchor }, i: number) => {
        // Spans that can be ordered without a take are checked here; the others are checked
        // once resolved against a take (generators, P0-6).
        const { at, until } = segment
        if (until !== undefined && isCertainlyNotAfter(until, at)) {
          ctx.addIssue({
            code: "custom",
            message: "`until` must be after `at`",
            path: ["tracks", track, i, "until"],
          })
        }
      })
    }
  })
/** A composition, with whole-document guards (forbidden keys, secret references). */
export const Composition = guarded(CompositionBase)
export type Composition = z.infer<typeof CompositionBase>
