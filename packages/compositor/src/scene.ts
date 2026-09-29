import {
  RIPPLE_MS,
  buildTimeline,
  clipRect,
  resolveAnchor,
  timeMap,
  type TakeInput,
  type TimeMap,
  type Timeline,
} from "@kiframe/generators"
import {
  applyStyle,
  DEFAULT_STYLE as SCHEMA_DEFAULT_STYLE,
  type Anchor,
  type CameraSegment,
  type Composition,
  type NRect,
  type Scenario,
  type Style as SchemaStyle,
} from "@kiframe/schema"

// What the output shows at a given output time (docs/OBJECT-MODEL.md §5), as plain data: pure and
// random-access (no state carried from frame to frame), so seeking gives the same frame as
// playing through, and preview = export. Drawing it is draw.ts's job.

export interface Style {
  /** Output size in pixels. */
  width: number
  height: number
  fps: number
  /** Background behind the window (CSS color or gradient stops). */
  background: [string, string]
  /** Space around the window, as a fraction of the output height. */
  padding: number
  /** Window corner radius, in output pixels. */
  radius: number
  /** Hard zoom cap (§2b): beyond source resolution the image gets soft; `softness` reports it. */
  maxScale: number
  /** Cursor height in output pixels at scale 1. */
  cursorSize: number
  /** Caption font size in output pixels. */
  captionSize: number
  /** Where captions go when a caption segment doesn't say. */
  captionPosition: "bottom" | "top"
}

/** The product defaults (packages/schema), flattened, at the landscape output size. */
export const DEFAULT_STYLE: Style = flatten(SCHEMA_DEFAULT_STYLE, {
  width: 1920,
  height: 1080,
  fps: 30,
})

/** A resolved schema style (resolveStyle) plus an output size, as the compositor draws it. */
export function flatten(
  style: SchemaStyle,
  format: { width: number; height: number; fps: number },
): Style {
  return {
    ...format,
    background: style.background,
    padding: style.padding,
    radius: style.radius,
    maxScale: style.maxScale,
    cursorSize: style.cursor.size,
    captionSize: style.captions.size,
    captionPosition: style.captions.position,
  }
}

/** The part of the source frame on screen: its center and zoom (1 = the whole frame). */
export interface View {
  scale: number
  cx: number
  cy: number
}

export interface Scene {
  /** Source time (ms) of the take frame to show. */
  sourceT: number
  view: View
  /** Regions to blur, normalized to the source frame. */
  blurs: NRect[]
  /** Normalized to the source frame; undefined when hidden. */
  cursor?: { x: number; y: number; pressed: boolean }
  ripples: { x: number; y: number; progress: number }[]
  captions: { text: string; position: "bottom" | "top" | "near-target" }[]
}

export interface Prepared {
  timeline: Timeline
  map: TimeMap
  style: Style
  composition: Composition
  /** The take's secret regions (drawn at every frame, whatever the composition says). */
  regions: Region[]
  /** Output duration in ms. */
  duration: number
  /**
   * How much the zoom upscales the source at worst: output pixels per source pixel at the highest
   * zoom used. Above 1 the image is softer than the capture (Phase 0 finding F1).
   */
  softness: number
  /** Camera changes in output time, with the spring's state when each starts. */
  moves: Move[]
}

/** Spring stiffness (rad/s): critically damped, settles in ~0.6 s. */
const OMEGA = 9
/** Follow-cursor: the camera aims at the cursor's average position over this much source time. */
const FOLLOW_WINDOW_MS = 400

type Vec = [number, number, number] // log(scale), cx, cy
interface Move {
  /** Output time the move starts. */
  t: number
  segment: CameraSegment | undefined
  x0: Vec
  v0: Vec
}

/**
 * `baseStyle` is the style resolved below the scene (product defaults, org, project: `resolveStyle`
 * without scene and output); the composition's own style (the scene) goes on it; `style` (the
 * output: size, format, its overrides) goes on top. Same order as `resolveStyle`.
 */
export function prepare(
  composition: Composition,
  scenario: Scenario,
  take: TakeInput,
  style: Partial<Style> = {},
  baseStyle: SchemaStyle = SCHEMA_DEFAULT_STYLE,
): Prepared {
  const size = { width: DEFAULT_STYLE.width, height: DEFAULT_STYLE.height, fps: DEFAULT_STYLE.fps }
  const s = { ...flatten(applyStyle(baseStyle, composition.style), size), ...style }
  const { timeline } = buildTimeline(scenario, take)
  const map = timeMap(composition.tracks.clips, timeline)
  const base: Omit<Prepared, "moves" | "softness"> = {
    timeline,
    map,
    style: s,
    composition,
    regions: timeline.events.filter((e): e is Region => e.kind === "sensitive"),
    duration: map.outputDuration,
  }
  const moves = cameraMoves(base)
  const maxScale = Math.max(
    1,
    ...composition.tracks.camera.map((c) => Math.min(c.scale, s.maxScale)),
  )
  const content = contentBox(s, take.meta.frameSize)
  const softness = (maxScale * content.w) / take.meta.frameSize.width
  return { ...base, moves, softness }
}

/** Where the take frame goes in the output (aspect kept, centered, inside the padding). */
export function contentBox(
  style: Style,
  frame: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  // A fraction of the shorter side: the same margin for landscape, vertical and square outputs.
  const pad = style.padding * Math.min(style.width, style.height)
  const availW = style.width - 2 * pad
  const availH = style.height - 2 * pad
  const k = Math.min(availW / frame.width, availH / frame.height)
  const w = frame.width * k
  const h = frame.height * k
  return { x: (style.width - w) / 2, y: (style.height - h) / 2, w, h }
}

/** A segment is shown at source time `s`; during a freeze at its `until` it still is. */
function active(
  p: Pick<Prepared, "timeline">,
  seg: { at: Anchor; until: Anchor },
  s: number,
  frozen: boolean,
): boolean {
  const a = resolveAnchor(seg.at, p.timeline)
  const b = resolveAnchor(seg.until, p.timeline)
  if (a === undefined || b === undefined) return false
  // A freeze holds the end of a step: what ends there stays, what starts there (the next step,
  // whose step_start has the same time) waits until the freeze is over.
  return frozen ? a < s && s <= b : a <= s && s < b
}

export function sceneAt(p: Prepared, tOut: number): Scene {
  const { t: sourceT, frozen } = p.map.toSource(tOut)
  const tracks = p.composition.tracks
  const tl = p.timeline

  // By source time, both ends included: the frame shown is what must be covered. Secret regions
  // straight from the take, each box over its own span (SECRETS-DESIGN I4: no composition edit
  // removes or shortens them, and no timing rule of the compositor's own).
  const blurs: NRect[] = secretRects(p.regions, sourceT)
  for (const m of tracks.masks) {
    if (m.kind !== "blur" && m.kind !== "pixelate") continue
    const a = resolveAnchor(m.at, tl)
    const b = resolveAnchor(m.until, tl)
    // Past its end too: frames just after it can still show what it hid (the capture lags the DOM).
    if (a === undefined || b === undefined || sourceT < a || sourceT > b + MASK_TAIL_MS) continue
    if ("rect" in m.target) blurs.push(m.target.rect)
    // Framed-element rects aren't recorded yet (P0-6 backlog): a privacy mask fails closed.
    else blurs.push({ x: 0, y: 0, w: 1, h: 1 })
  }

  const hidden = tracks.cursor.some((c) => c.kind === "hidden" && active(p, c, sourceT, frozen))
  const cursor = hidden ? undefined : cursorAt(tl, sourceT)
  const ripples = tracks.cursor.flatMap((c) => {
    // A hidden cursor shows no clicks either.
    if (c.kind !== "click-ripple" || hidden) return []
    const a = resolveAnchor(c.at, tl)
    if (a === undefined) return []
    // The segment's own length, in output time whatever the playback speed around it.
    const b = resolveAnchor(c.until, tl)
    const length = b === undefined || b <= a ? RIPPLE_MS : b - a
    const progress = (tOut - p.map.toOutput(a)) / length
    if (progress < 0 || progress > 1) return []
    const at = cursorAt(tl, a)
    return at === undefined ? [] : [{ x: at.x, y: at.y, progress }]
  })
  const captions = tracks.captions
    .filter((c) => active(p, c, sourceT, frozen))
    .map((c) => ({ text: c.text, position: c.position ?? p.style.captionPosition }))

  return {
    sourceT,
    view: viewAt(p, tOut, sourceT),
    blurs,
    ...(cursor !== undefined && { cursor }),
    ripples,
    captions,
  }
}

/** A composition mask lasts this long past its end (its `until` is DOM or step timing). */
const MASK_TAIL_MS = 250

type Region = Extract<Timeline["events"][number], { kind: "sensitive" }>

/** The boxes of the take's secret regions on screen at source time `t`. */
function secretRects(regions: readonly Region[], t: number): NRect[] {
  const out: NRect[] = []
  for (const e of regions) {
    if (t < e.t || t > e.until) continue
    for (const box of e.boxes) {
      if (t < box.from || t > box.until) continue
      const rect = clipRect(box.rect)
      if (rect !== undefined) out.push(rect)
    }
  }
  return out
}

/**
 * The cursor at source time `t`: between two samples of a move it's interpolated; between moves
 * it rests where the last one ended; before the first move it waits at its starting point.
 */
export function cursorAt(
  tl: Timeline,
  t: number,
): { x: number; y: number; pressed: boolean } | undefined {
  const samples = tl.cursor
  const first = samples[0]
  if (first === undefined) return undefined
  if (t <= first.t) return { x: first.p.x, y: first.p.y, pressed: false }
  // Binary search: the last sample at or before t.
  let lo = 0
  let hi = samples.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (samples[mid]!.t <= t) lo = mid
    else hi = mid - 1
  }
  const p = samples[lo]!
  const q = samples[lo + 1]
  // Interpolate only inside a move (samples ~16 ms apart), never across a rest.
  if (q === undefined || q.t - p.t > 100) return { x: p.p.x, y: p.p.y, pressed: p.pressed }
  const u = (t - p.t) / (q.t - p.t)
  return { x: p.p.x + (q.p.x - p.p.x) * u, y: p.p.y + (q.p.y - p.p.y) * u, pressed: p.pressed }
}

// ─── Camera: analytic critically damped spring ────────────────────────────────

/** The camera segment in effect at source time `s` (the last one listed wins on overlap). */
function cameraSegmentAt(
  p: Pick<Prepared, "timeline" | "composition">,
  s: number,
  frozen: boolean,
): CameraSegment | undefined {
  let found: CameraSegment | undefined
  for (const c of p.composition.tracks.camera) if (active(p, c, s, frozen)) found = c
  return found
}

/** Where a segment aims (log scale, center), at source time `s` (follow-cursor moves). */
function targetOf(
  p: Omit<Prepared, "moves" | "softness">,
  seg: CameraSegment | undefined,
  s: number,
): Vec {
  if (seg === undefined) return [0, 0.5, 0.5]
  const scale = Math.min(seg.scale, p.style.maxScale)
  const focus = seg.focus
  let c: { x: number; y: number }
  if (focus.mode === "rect")
    c = { x: focus.rect.x + focus.rect.w / 2, y: focus.rect.y + focus.rect.h / 2 }
  else if (focus.mode === "point") c = focus.p
  else c = followPoint(p.timeline, s)
  return [Math.log(scale), c.x, c.y]
}

/** Average cursor position over the last FOLLOW_WINDOW_MS: smooth, and deterministic. */
function followPoint(tl: Timeline, s: number): { x: number; y: number } {
  let x = 0
  let y = 0
  const n = 8
  for (let i = 0; i < n; i++) {
    const c = cursorAt(tl, s - (FOLLOW_WINDOW_MS * i) / (n - 1)) ?? { x: 0.5, y: 0.5 }
    x += c.x
    y += c.y
  }
  return { x: x / n, y: y / n }
}

/**
 * Camera changes in output time. Each starts a spring from the state the previous one reached at
 * that moment (position and velocity): computed once, so any frame is one closed-form evaluation.
 */
function cameraMoves(p: Omit<Prepared, "moves" | "softness">): Move[] {
  // Candidate change points: every segment's start and end, in output time.
  const times = new Set<number>([0])
  for (const c of p.composition.tracks.camera) {
    const a = resolveAnchor(c.at, p.timeline)
    const b = resolveAnchor(c.until, p.timeline)
    // A start on a freeze takes effect when the freeze ends (inclusive): both times are candidates.
    if (a !== undefined) times.add(p.map.toOutput(a)).add(p.map.toOutput(a, { inclusive: true }))
    if (b !== undefined) times.add(p.map.toOutput(b, { inclusive: true }))
  }
  const sorted = [...times].filter((t) => t >= 0 && t <= p.duration).sort((x, y) => x - y)
  const moves: Move[] = []
  for (const t of sorted) {
    const { t: s, frozen } = p.map.toSource(t)
    const segment = cameraSegmentAt(p, s, frozen)
    const prev = moves.at(-1)
    if (prev !== undefined && prev.segment === segment) continue
    let x0: Vec
    let v0: Vec
    if (prev === undefined) {
      x0 = targetOf(p, segment, s)
      v0 = [0, 0, 0]
    } else if (segment?.ease === "instant") {
      x0 = targetOf(p, segment, s)
      v0 = [0, 0, 0]
    } else {
      const state = springState(p, prev, t)
      x0 = state.x
      v0 = state.v
    }
    moves.push({ t, segment, x0, v0 })
  }
  return moves
}

/** State of a move's spring at output time `t`: x(τ) = T + (c + dτ)e^(−ωτ). */
function springState(
  p: Omit<Prepared, "moves" | "softness">,
  move: Move,
  t: number,
): { x: Vec; v: Vec } {
  const tau = Math.max(0, t - move.t) / 1000
  const target = targetOf(p, move.segment, p.map.toSource(t).t)
  const e = Math.exp(-OMEGA * tau)
  const x: Vec = [0, 0, 0]
  const v: Vec = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const c = move.x0[i]! - target[i]!
    const d = move.v0[i]! + OMEGA * c
    x[i] = target[i]! + (c + d * tau) * e
    v[i] = (d - OMEGA * (c + d * tau)) * e
  }
  return { x, v }
}

function viewAt(p: Prepared, tOut: number, sourceT: number): View {
  let move = p.moves[0]
  for (const m of p.moves) if (m.t <= tOut) move = m
  const x = move === undefined ? targetOf(p, undefined, sourceT) : springState(p, move, tOut).x
  const scale = Math.min(p.style.maxScale, Math.max(1, Math.exp(x[0])))
  // Keep the view inside the frame (no empty border when zoomed near an edge).
  const half = 0.5 / scale
  return {
    scale,
    cx: Math.min(1 - half, Math.max(half, x[1])),
    cy: Math.min(1 - half, Math.max(half, x[2])),
  }
}
