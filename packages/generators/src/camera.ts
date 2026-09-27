import {
  CAMERA_SCALE,
  type CameraDefault,
  type CameraDirective,
  type CameraSegment,
  type NRect,
  type ViewportRect,
} from "@kiframe/schema"
import { anchorFor, type StepSpan, type Timeline } from "./timeline.ts"

// Camera (docs/OBJECT-MODEL.md §2b, §4.1): each step's `camera` directive becomes framing intent
// (focus + scale); the renderer's spring turns it into motion. Wide (scale 1) is the base: no
// segment means wide.

export interface CameraOptions {
  /** Highest zoom the generator picks by itself (`auto`, `target`). Default 2. */
  maxAutoScale?: number
  /** Zoom for `follow: cursor`. Default 1.8. */
  followScale?: number
  /** Below this, zooming isn't worth it: the step stays wide. Default 1.2. */
  minScale?: number
  /** Minimum time a framing is held (~1.3 s, from programmatic-demo). */
  minHoldMs?: number
  /** Nearby actions closer than this in time share one framing (`auto` clusters). Default 2500 ms. */
  clusterGapMs?: number
  /** A zoom-out shorter than this between two framings is skipped (no out-and-in bounce). Default 800 ms. */
  bridgeMs?: number
}

interface Framing {
  first: StepSpan
  a: number
  b: number
  scale: number
  focus: CameraSegment["focus"]
}

/** The directive in effect for a step: its own, else the scene's, else the project's. */
export function effectiveCamera(
  span: StepSpan,
  sceneDefault: CameraDefault | undefined,
  projectDefault: CameraDefault,
): CameraDirective {
  return span.step.camera ?? sceneDefault ?? projectDefault
}

export function generateCamera(
  tl: Timeline,
  directives: Map<string, CameraDirective>,
  options: CameraOptions = {},
): { camera: CameraSegment[]; warnings: string[] } {
  const maxAuto = options.maxAutoScale ?? 2
  const followScale = options.followScale ?? 1.8
  const minScale = options.minScale ?? 1.2
  const minHold = options.minHoldMs ?? 1300
  const gapMs = options.clusterGapMs ?? 2500
  const bridge = options.bridgeMs ?? 800
  const warnings: string[] = []
  const framings: Framing[] = []

  // Lead-in grows with the distance the view travels (a far jump needs more time to read).
  let lastCenter = { x: 0.5, y: 0.5 }
  const leadIn = (rect: NRect) => {
    const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
    const ms = 400 + 600 * Math.min(1, Math.hypot(c.x - lastCenter.x, c.y - lastCenter.y))
    lastCenter = c
    return ms
  }
  const frameRect = (first: StepSpan, a: number, b: number, rect: NRect, scale: number) => {
    framings.push({ first, a: a - leadIn(rect), b: b + 400, scale, focus: { mode: "rect", rect } })
  }

  let cluster: { first: StepSpan; rect: NRect; a: number; b: number } | undefined
  const flush = () => {
    if (cluster === undefined) return
    const scale = Math.min(maxAuto, fitScale(cluster.rect))
    if (scale >= minScale) frameRect(cluster.first, cluster.a, cluster.b, cluster.rect, scale)
    cluster = undefined
  }

  let coveredUntil = -1
  tl.steps.forEach((span, i) => {
    // Inside an earlier step's `until` span: that framing already covers this step.
    if (i <= coveredUntil) return
    const directive = directives.get(span.id) ?? "auto"
    const rect = targetRect(span, tl)
    const navigates = tl.events.some((e) => e.stepId === span.id && e.kind === "navigate")
    if (directive === "auto") {
      // A navigation or a scroll changes the whole view: wide from there.
      if (span.step.action === "goto" || span.step.action === "scroll") return flush()
      // Whether this step is part of the current framing (a navigation in it then ends it there).
      let joined = false
      if (rect !== undefined) {
        joined = true
        const union = cluster === undefined ? rect : unionRect(cluster.rect, rect)
        const joins =
          cluster !== undefined &&
          span.start - cluster.b <= gapMs &&
          Math.min(maxAuto, fitScale(union)) >= minScale
        if (!joins) flush()
        cluster =
          cluster === undefined
            ? { first: span, rect, a: span.start, b: span.end }
            : { ...cluster, rect: union, b: span.end }
      } else if (cluster !== undefined && span.start - cluster.b <= gapMs) {
        // A step with nothing to frame (press, wait, check) keeps the current framing, but not
        // through a long wait: nobody looks at an untouched button for 10 s.
        joined = true
        cluster.b = Math.min(span.end, span.start + gapMs)
        if (span.end - span.start > gapMs) flush()
      } else {
        flush()
      }
      if (navigates) {
        const nav = tl.events.find((e) => e.stepId === span.id && e.kind === "navigate")
        if (joined && cluster !== undefined && nav !== undefined) {
          cluster.b = Math.max(cluster.a + 1, nav.t)
        }
        flush()
      }
      return
    }
    flush()
    if (directive === "wide") return
    const untilId = typeof directive === "object" ? directive.until : undefined
    const untilIndex = untilId === undefined ? -1 : tl.steps.findIndex((s) => s.id === untilId)
    const endSpan = untilIndex > i ? tl.steps[untilIndex] : span
    if (untilIndex > i) coveredUntil = untilIndex
    const b = endSpan?.end ?? span.end
    if (directive === "target" || (typeof directive === "object" && "frame" in directive)) {
      const frame = directive === "target" ? "target" : directive.frame
      const forced =
        typeof directive === "object" && "scale" in directive ? directive.scale : undefined
      let r: NRect | undefined
      if (frame === "target") r = rect
      else if ("rect" in frame) {
        const [x, y, w, h] = frame.rect
        r = { x, y, w, h }
      } else {
        warnings.push(`step ${span.id}: framing another element isn't recorded yet: kept wide`)
        return
      }
      if (r === undefined) {
        warnings.push(`step ${span.id}: no target position in the take: kept wide`)
        return
      }
      const scale = forced ?? Math.min(maxAuto, fitScale(r))
      if (forced !== undefined || scale >= minScale)
        frameRect(span, span.start, b, r, clampScale(scale))
      return
    }
    // { follow: cursor }
    framings.push({
      first: span,
      a: span.start - 300,
      b: b + 400,
      scale: followScale,
      focus: { mode: "follow-cursor" },
    })
  })
  flush()

  // Timing rules: a minimum hold, no overlap, and no short zoom-out between two framings.
  // Framings come in step order. A lead-in never reaches back over the previous framing's own
  // hold: at the latest, the next framing starts with its step.
  const sorted: Framing[] = []
  for (const f of framings) {
    const prev = sorted.at(-1)
    let a = Math.max(0, f.a)
    if (prev !== undefined) a = Math.max(a, Math.min(f.first.start, prev.a + minHold))
    sorted.push({ ...f, a, b: Math.min(tl.duration, Math.max(f.b, a + minHold)) })
  }
  sorted.forEach((f, i) => {
    const next = sorted[i + 1]
    if (next === undefined) return
    if (next.a < f.b || next.a - f.b < bridge) f.b = next.a
  })
  const camera: CameraSegment[] = sorted
    .filter((f) => f.b - f.a >= 1)
    .map((f) => ({
      id: `camera:${f.first.id}`,
      source: "auto",
      at: anchorFor(f.a, tl),
      until: anchorFor(f.b, tl),
      scale: round2(f.scale),
      focus: f.focus,
    }))
  return { camera, warnings }
}

/** Where the step's target was: the rect of its click or of the field it typed into. */
function targetRect(span: StepSpan, tl: Timeline): NRect | undefined {
  const event = tl.events.find(
    (e) =>
      e.stepId === span.id &&
      e.phase === "steps" &&
      (e.kind === "click" || e.kind === "type_start"),
  )
  if (event === undefined || !("rect" in event)) return undefined
  return clip(event.rect)
}

/** A take rect clipped to the frame; undefined when nothing of it is on screen. */
function clip(r: ViewportRect): NRect | undefined {
  const x = Math.max(0, r.x)
  const y = Math.max(0, r.y)
  const w = Math.min(1, r.x + r.w) - x
  const h = Math.min(1, r.y + r.h) - y
  return w > 0 && h > 0 ? { x, y, w, h } : undefined
}

function unionRect(p: NRect, q: NRect): NRect {
  const x = Math.min(p.x, q.x)
  const y = Math.min(p.y, q.y)
  return { x, y, w: Math.max(p.x + p.w, q.x + q.w) - x, h: Math.max(p.y + p.h, q.y + q.h) - y }
}

/**
 * The zoom that shows `rect` with room around it: the element takes at most ~60% of the frame
 * (a small field still shows its label and surroundings).
 */
export function fitScale(rect: NRect): number {
  const visibleW = rect.w * 1.6 + 0.06
  const visibleH = rect.h * 1.6 + 0.06
  return clampScale(1 / Math.max(visibleW, visibleH))
}

function clampScale(s: number): number {
  return Math.min(CAMERA_SCALE.max, Math.max(CAMERA_SCALE.min, s))
}

const round2 = (n: number) => Math.round(n * 100) / 100
