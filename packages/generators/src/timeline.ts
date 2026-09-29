import {
  type Anchor,
  type ClipSegment,
  type CursorSample,
  parseEventAnchor,
  type Scenario,
  type Step,
  type TakeEvent,
  type TakeMeta,
} from "@kiframe/schema"

// A take seen as a timeline: where each on-camera step starts and ends, and how anchors
// (docs/OBJECT-MODEL.md §4) resolve to source time.

/** What the generators read from a take (the recorder's result, or a take folder loaded from disk). */
export interface TakeInput {
  meta: TakeMeta
  events: TakeEvent[]
  cursor: CursorSample[]
}

export interface StepSpan {
  id: string
  step: Step
  /** Source time (ms) of `step_start` / `step_end`. */
  start: number
  end: number
}

export interface Timeline {
  /** On-camera steps found in the take, in scenario order. */
  steps: StepSpan[]
  byId: Map<string, StepSpan>
  duration: number
  /** The take's events, but its secret regions (spans, not moments: nothing anchors to them). */
  events: TakeEvent[]
  /** The take's secret regions: drawn at render time, whatever the composition says (I4). */
  regions: Extract<TakeEvent, { kind: "sensitive" }>[]
  cursor: CursorSample[]
}

/**
 * Builds the timeline of a complete take. Steps of the scenario that the take doesn't have (the
 * scenario changed since) are reported in `missing`: their segments can't be placed.
 */
export function buildTimeline(
  scenario: Scenario,
  take: TakeInput,
): { timeline: Timeline; missing: string[] } {
  if (take.meta.outcome.status !== "complete") {
    throw new Error("a failed take can't be edited: re-record it")
  }
  const duration = take.meta.durationMs
  const starts = new Map<string, number>()
  const ends = new Map<string, number>()
  for (const e of take.events) {
    if (e.phase !== "steps" || e.stepId === undefined) continue
    if (e.kind === "step_start" && !starts.has(e.stepId)) starts.set(e.stepId, e.t)
    if (e.kind === "step_end") ends.set(e.stepId, e.t)
  }
  const steps: StepSpan[] = []
  const missing: string[] = []
  for (const step of scenario.steps) {
    const start = starts.get(step.id)
    if (start === undefined) {
      missing.push(step.id)
      continue
    }
    steps.push({ id: step.id, step, start, end: Math.max(start, ends.get(step.id) ?? duration) })
  }
  // In recorded order: the scenario may have been reordered since the take (re-record to apply).
  steps.sort((x, y) => x.start - y.start)
  return {
    timeline: {
      steps,
      byId: new Map(steps.map((s) => [s.id, s])),
      duration,
      events: take.events.filter((e) => e.kind !== "sensitive"),
      regions: take.events.filter(
        (e): e is Extract<TakeEvent, { kind: "sensitive" }> => e.kind === "sensitive",
      ),
      cursor: take.cursor,
    },
    missing,
  }
}

/**
 * Event anchors name an event of a step: `<stepId>:<kind>`, or `<stepId>:<kind>:<n>` for its n-th
 * event of that kind (0-based). Example: `save:click`.
 */
export function eventId(stepId: string, kind: TakeEvent["kind"], n = 0): string {
  return n === 0 ? `${stepId}:${kind}` : `${stepId}:${kind}:${n}`
}

/** Source time of an anchor in this take, clamped to the take; undefined if it doesn't exist here. */
export function resolveAnchor(anchor: Anchor, tl: Timeline): number | undefined {
  const clamp = (t: number) => Math.min(tl.duration, Math.max(0, t))
  if ("ms" in anchor) return clamp(anchor.ms)
  const offset = anchor.offsetMs ?? 0
  if ("scene" in anchor) return clamp(anchor.scene === "start" ? offset : tl.duration + offset)
  if ("step" in anchor) {
    const span = tl.byId.get(anchor.step)
    if (span === undefined) return undefined
    return clamp((anchor.edge === "start" ? span.start : span.end) + offset)
  }
  const parsed = parseEventAnchor(anchor.event)
  if (parsed === undefined) return undefined
  const found = tl.events.filter((e) => e.stepId === parsed.step && e.kind === parsed.kind)[
    parsed.n
  ]
  return found === undefined ? undefined : clamp(found.t + offset)
}

/**
 * An anchor for source time `t`, relative to the start of the step running at `t` (or the first
 * step, before it): segments keep their meaning when a re-record shifts the timing.
 */
export function anchorFor(
  t: number,
  tl: Timeline,
  rounding: "nearest" | "down" | "up" = "nearest",
): Anchor {
  const round = rounding === "down" ? Math.floor : rounding === "up" ? Math.ceil : Math.round
  const first = tl.steps[0]
  if (first === undefined) return { ms: Math.max(0, round(t)) }
  let span = first
  for (const s of tl.steps) if (s.start <= t) span = s
  const offsetMs = round(t - span.start)
  return offsetMs === 0
    ? { step: span.id, edge: "start" }
    : { step: span.id, edge: "start", offsetMs }
}

/** Source → output (and back) for a set of clips. */
export interface TimeMap {
  /**
   * Output time of source time `t`. With `inclusive`, a freeze at `t` itself counts: that's where
   * a segment whose `until` is `t` ends (segments covering a freeze stay shown during it).
   */
  toOutput: (t: number, options?: { inclusive?: boolean }) => number
  /** Source time shown at output time `t`, and whether it's a freeze (the frame is held). */
  toSource: (t: number) => { t: number; frozen: boolean }
  outputDuration: number
}

/**
 * Source → output time for a set of clips. Cut spans take no output time, speed spans take
 * 1/speed of it, and a freeze at `t` adds its `ms` right after `t`. Overlapping spans: the first
 * one listed wins (generators never emit overlaps).
 */
export function timeMap(clips: ClipSegment[], tl: Timeline): TimeMap {
  const spans: { a: number; b: number; rate: number }[] = []
  const freezes: { t: number; ms: number }[] = []
  for (const c of clips) {
    const a = resolveAnchor(c.at, tl)
    if (a === undefined) continue
    if (c.mode === "freeze") {
      freezes.push({ t: a, ms: c.ms })
      continue
    }
    const b = resolveAnchor(c.until, tl)
    if (b === undefined || b <= a) continue
    const rate = c.mode === "cut" ? 0 : 1 / c.speed
    // Keep only the parts not already covered by an earlier span.
    let pieces = [{ a, b }]
    for (const s of spans) {
      pieces = pieces.flatMap((p) =>
        s.b <= p.a || s.a >= p.b
          ? [p]
          : [
              ...(p.a < s.a ? [{ a: p.a, b: s.a }] : []),
              ...(s.b < p.b ? [{ a: s.b, b: p.b }] : []),
            ],
      )
    }
    for (const p of pieces) spans.push({ ...p, rate })
  }
  const toOutput = (t: number, options: { inclusive?: boolean } = {}) => {
    let out = t
    for (const s of spans) {
      const covered = Math.max(0, Math.min(t, s.b) - s.a)
      out -= covered * (1 - s.rate)
    }
    for (const f of freezes) if (f.t < t || (options.inclusive === true && f.t === t)) out += f.ms
    return out
  }
  // A freeze at the very end still plays.
  const tail = freezes.filter((f) => f.t >= tl.duration).reduce((sum, f) => sum + f.ms, 0)
  const outputDuration = toOutput(tl.duration) + tail

  // The inverse, as ordered pieces: [source a, b) played at `rate`, or a freeze held for `ms`.
  const edges = new Set<number>([0, tl.duration])
  for (const s of spans) edges.add(s.a).add(s.b)
  for (const f of freezes) edges.add(Math.min(tl.duration, f.t))
  const points = [...edges].filter((e) => e >= 0 && e <= tl.duration).sort((x, y) => x - y)
  type Piece = { outA: number; outB: number; srcA: number; srcB: number; frozen: boolean }
  const pieces: Piece[] = []
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!
    // Freezes at this point come first: they hold the frame at `a`.
    const held = freezes
      .filter((f) => Math.min(tl.duration, f.t) === a)
      .reduce((s, f) => s + f.ms, 0)
    if (held > 0) {
      const outA = toOutput(a)
      pieces.push({ outA, outB: outA + held, srcA: a, srcB: a, frozen: true })
    }
    const b = points[i + 1]
    if (b === undefined || b <= a) continue
    const outA = toOutput(a, { inclusive: true })
    const outB = toOutput(b)
    if (outB > outA) pieces.push({ outA, outB, srcA: a, srcB: b, frozen: false })
  }
  const toSource = (t: number) => {
    const clamped = Math.min(outputDuration, Math.max(0, t))
    // The piece holding `t` (the last one that starts at or before it).
    let piece = pieces[0]
    for (const p of pieces) if (p.outA <= clamped) piece = p
    if (piece === undefined) return { t: 0, frozen: false }
    if (piece.frozen) return { t: piece.srcA, frozen: true }
    const u = Math.min(1, (clamped - piece.outA) / (piece.outB - piece.outA))
    return { t: piece.srcA + u * (piece.srcB - piece.srcA), frozen: false }
  }
  return { toOutput, toSource, outputDuration }
}
