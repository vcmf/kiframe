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
  /** Ended by a navigation: no tail, no minimum-hold stretch (the framed element is gone). */
  hardEnd?: boolean
}

/** The directive in effect for a step: its own, else the scene's, else the project's. */
export function effectiveCamera(
  span: StepSpan,
  sceneDefault: CameraDefault | undefined,
  projectDefault: CameraDefault,
): CameraDirective {
  return span.step.camera ?? sceneDefault ?? projectDefault
}

/**
 * `toOutput` maps source time to output time (the clips): gaps are judged as the viewer sees them,
 * so a wait sped up to 1 s doesn't split a framing.
 */
export function generateCamera(
  tl: Timeline,
  directives: Map<string, CameraDirective>,
  options: CameraOptions = {},
  toOutput: (t: number) => number = (t) => t,
): { camera: CameraSegment[]; warnings: string[] } {
  const seen = (a: number, b: number) => toOutput(b) - toOutput(a)
  const maxAuto = options.maxAutoScale ?? 2
  const followScale = options.followScale ?? 1.8
  const minScale = options.minScale ?? 1.2
  const minHold = options.minHoldMs ?? 1300
  const gapMs = options.clusterGapMs ?? 2500
  const bridge = options.bridgeMs ?? 800
  const warnings: string[] = []
  const framings: Framing[] = []

  // Lead-in: at least ~600 ms to settle in (§4.1), more when the view travels far.
  const center = { x: 0.5, y: 0.5 }
  let lastCenter = center
  const leadIn = (rect: NRect) => {
    const c = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }
    const ms = 600 + 400 * Math.min(1, Math.hypot(c.x - lastCenter.x, c.y - lastCenter.y))
    lastCenter = c
    return ms
  }
  const frameRect = (
    first: StepSpan,
    a: number,
    b: number,
    rect: NRect,
    scale: number,
    hardEnd = false,
  ) => {
    framings.push({
      first,
      a: a - leadIn(rect),
      b: hardEnd ? b : b + 400,
      scale,
      focus: { mode: "rect", rect },
      hardEnd,
    })
  }

  let cluster: { first: StepSpan; rect: NRect; a: number; b: number } | undefined
  const flush = (hardEnd = false) => {
    if (cluster === undefined) return
    const scale = Math.min(maxAuto, fitScale(cluster.rect))
    if (scale >= minScale) {
      frameRect(cluster.first, cluster.a, cluster.b, cluster.rect, scale, hardEnd)
    }
    cluster = undefined
  }
  /** The view goes back to the whole frame: the next lead-in travels from its center. */
  const goWide = (hardEnd = false) => {
    flush(hardEnd)
    lastCenter = center
  }
  // A default `frame: <locator>` would warn on every step: once is enough.
  let warnedDefaultFrame = false

  let coveredUntil = -1
  tl.steps.forEach((span, i) => {
    const directive = directives.get(span.id) ?? "auto"
    // Inside an earlier step's `until` span: that framing already covers this step.
    if (i <= coveredUntil) {
      if (span.step.camera !== undefined && span.step.camera !== "auto") {
        warnings.push(`step ${span.id}: camera ignored (inside an earlier step's camera.until)`)
      }
      return
    }
    const rect = targetRect(span, tl)
    const nav = tl.events.find((e) => e.stepId === span.id && e.kind === "navigate")
    if (directive === "auto") {
      // A navigation or a scroll changes the whole view: wide from there.
      if (span.step.action === "goto" || span.step.action === "scroll") return goWide()
      // Whether this step is part of the current framing (a navigation in it then ends it there).
      let joined = false
      if (rect !== undefined) {
        joined = true
        const union = cluster === undefined ? rect : unionRect(cluster.rect, rect)
        const joins =
          cluster !== undefined &&
          seen(cluster.b, span.start) <= gapMs &&
          Math.min(maxAuto, fitScale(union)) >= minScale
        if (!joins) flush()
        cluster =
          cluster === undefined
            ? { first: span, rect, a: span.start, b: span.end }
            : { ...cluster, rect: union, b: span.end }
      } else if (cluster !== undefined && seen(cluster.b, span.start) <= gapMs) {
        // A step with nothing to frame (press, wait, check) keeps the current framing, but not
        // through a long wait: nobody looks at an untouched button for 10 s.
        joined = true
        cluster.b = Math.min(span.end, span.start + gapMs)
        if (seen(span.start, span.end) > gapMs) flush()
      } else {
        flush()
      }
      if (nav !== undefined) {
        if (joined && cluster !== undefined) {
          cluster.b = Math.max(cluster.a + 1, nav.t)
        }
        goWide(joined)
      }
      return
    }
    flush()
    if (directive === "wide") return goWide()
    const untilId = typeof directive === "object" ? directive.until : undefined
    const untilIndex = untilId === undefined ? -1 : tl.steps.findIndex((s) => s.id === untilId)
    const endSpan = untilIndex > i ? tl.steps[untilIndex] : span
    if (untilIndex > i) coveredUntil = untilIndex
    else if (untilId !== undefined) {
      warnings.push(
        `step ${span.id}: camera.until step ${untilId} isn't in the take: this step only`,
      )
    }
    // Without `until`, a navigation in the step ends the framing (the old element is gone).
    const b = untilIndex > i ? (endSpan?.end ?? span.end) : Math.min(span.end, nav?.t ?? Infinity)
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
        if (span.step.camera !== undefined || !warnedDefaultFrame) {
          warnings.push(
            span.step.camera !== undefined
              ? `step ${span.id}: framing another element isn't recorded yet: kept wide`
              : "the default camera frames another element, which isn't recorded yet: kept wide",
          )
          if (span.step.camera === undefined) warnedDefaultFrame = true
        }
        return
      }
      if (r === undefined) {
        warnings.push(`step ${span.id}: no target position in the take: kept wide`)
        return
      }
      const scale = forced ?? Math.min(maxAuto, fitScale(r))
      const hardEnd = untilIndex <= i && nav !== undefined
      if (forced !== undefined || scale >= minScale)
        frameRect(span, span.start, b, r, clampScale(scale), hardEnd)
      if (hardEnd) lastCenter = center
      return
    }
    // { follow: cursor }
    framings.push({
      first: span,
      a: span.start - 300,
      b: b + 400,
      scale: clampScale(followScale),
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
    const b = f.hardEnd === true ? Math.max(f.b, a + 1) : Math.max(f.b, a + minHold)
    sorted.push({ ...f, a, b: Math.min(tl.duration, b) })
  }
  sorted.forEach((f, i) => {
    const next = sorted[i + 1]
    if (next === undefined) return
    if (next.a < f.b || seen(f.b, next.a) < bridge) f.b = next.a
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

export const round2 = (n: number) => Math.round(n * 100) / 100
