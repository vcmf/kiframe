import * as z from "zod"
import { claimIds, Ms, NPoint, NRect, PlainText, StepId } from "./common.ts"
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
  z.strictObject({ scene: z.enum(["start", "end"]), offsetMs: z.number().int().optional() }),
  z.strictObject({ ms: Ms }),
])
export type Anchor = z.infer<typeof Anchor>

/**
 * Orders two anchors when that's possible without a take. Returns a negative number if `a` is
 * before `b`, 0 if equal, positive if after, and undefined when only a take can tell.
 *
 * Two anchors on the same edge (same step edge, same scene edge, same event) differ only by their
 * offsets. Anchors on different edges of the same step/scene can only be ordered without offsets
 * (a step's start is never after its end); with offsets, the duration decides, which needs a take.
 * `{ scene: "start" }` is source time 0, so it also compares with absolute `{ ms }` anchors.
 */
export function compareStaticAnchors(a: Anchor, b: Anchor): number | undefined {
  const edge = (e: "start" | "end") => (e === "start" ? 0 : 1)
  const offset = (x: { offsetMs?: number | undefined }) => x.offsetMs ?? 0
  const sameEdgeOrUnknown = (edgeA: number, edgeB: number, offA: number, offB: number) => {
    if (edgeA === edgeB) return offA - offB
    return offA === 0 && offB === 0 ? edgeA - edgeB : undefined
  }
  const absolute = (x: Anchor): number | undefined => {
    if ("ms" in x) return x.ms
    if ("scene" in x && x.scene === "start") return offset(x)
    return undefined
  }
  const absA = absolute(a)
  const absB = absolute(b)
  if (absA !== undefined && absB !== undefined) return absA - absB
  if ("scene" in a && "scene" in b) {
    return sameEdgeOrUnknown(edge(a.scene), edge(b.scene), offset(a), offset(b))
  }
  if ("step" in a && "step" in b && a.step === b.step) {
    return sameEdgeOrUnknown(edge(a.edge), edge(b.edge), offset(a), offset(b))
  }
  if ("event" in a && "event" in b && a.event === b.event) return offset(a) - offset(b)
  return undefined
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
    reason: ClipReason.optional(),
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
  text: PlainText.min(1),
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

export const CalloutSegment = z.strictObject({
  ...segmentBase,
  kind: z.enum(["arrow", "text", "badge"]),
  text: PlainText.optional(),
  target: z.union([
    z.strictObject({ frameRef: z.string().min(1) }),
    z.strictObject({ rect: NRect }),
  ]),
})
export type CalloutSegment = z.infer<typeof CalloutSegment>

export const KeystrokeSegment = z.strictObject({ ...segmentBase, keys: PlainText.min(1) })
export type KeystrokeSegment = z.infer<typeof KeystrokeSegment>

export const Composition = z
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
        const order = until === undefined ? undefined : compareStaticAnchors(until, at)
        if (order !== undefined && order <= 0) {
          ctx.addIssue({
            code: "custom",
            message: "`until` must be after `at`",
            path: ["tracks", track, i, "until"],
          })
        }
      })
    }
  })
export type Composition = z.infer<typeof Composition>
