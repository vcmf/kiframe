import { MAX_SPEED, type ClipSegment } from "@kiframe/schema"
import { anchorFor, type StepSpan, type Timeline } from "./timeline.ts"

// The time model (docs/OBJECT-MODEL.md §4), rules applied in order:
// 1. a caption window, a `pause` or a `hold` is never sped up or cut;
// 2. setup (and teardown) is cut;
// 3. remaining idle time over 1.5 s is sped up;
// 4. a caption that needs more reading time than its step lasts gets a freeze at the step end.

export interface ClipOptions {
  /** Idle stretches longer than this are sped up. Default 1500 ms. */
  idleThresholdMs?: number
  /** Speed of an idle stretch; faster for very long ones so each lasts at most `idleThresholdMs`. Default 4. */
  idleSpeed?: number
  /** Real-time margin kept at both ends of an idle stretch. Default 300 ms. */
  idleMarginMs?: number
  /** Kept after the last step before the teardown cut: the result stays on screen. Default 800 ms. */
  endBeatMs?: number
}

/** Reading time of a caption: ~200 words per minute, at least 1.5 s. */
export function readingTimeMs(text: string): number {
  const words = text.trim().split(/\s+/).length
  return Math.max(1500, 500 + words * 300)
}

type Span = { a: number; b: number }

const NAVIGATE_BUSY_MS = 300

export function generateClips(
  tl: Timeline,
  options: ClipOptions = {},
): { clips: ClipSegment[]; warnings: string[] } {
  const threshold = options.idleThresholdMs ?? 1500
  const idleSpeed = options.idleSpeed ?? 4
  const margin = options.idleMarginMs ?? 300
  const endBeat = options.endBeatMs ?? 800
  const warnings: string[] = []
  const clips: ClipSegment[] = []
  const first = tl.steps[0]
  const last = tl.steps.at(-1)
  if (first === undefined || last === undefined) return { clips, warnings }

  // Rule 1: protected windows.
  const isProtected = (s: StepSpan) => s.step.caption !== undefined || s.step.action === "pause"
  const protectedSpans: Span[] = tl.steps.filter(isProtected).map((s) => ({ a: s.start, b: s.end }))

  // Rule 2: setup and teardown are cut.
  if (first.start > 0) {
    clips.push({
      id: "clip:setup",
      source: "auto",
      mode: "cut",
      at: { scene: "start" },
      until: { step: first.id, edge: "start" },
      reason: "setup",
    })
  }
  // The teardown runs right after the last step: the end beat stops where it starts.
  const teardownStart = tl.events.find((e) => e.phase === "teardown" && e.t >= last.end)?.t
  const end = Math.min(tl.duration, last.end + endBeat, teardownStart ?? Infinity)
  if (end < tl.duration) {
    clips.push({
      id: "clip:teardown",
      source: "auto",
      mode: "cut",
      at: {
        step: last.id,
        edge: "end",
        ...(end > last.end && { offsetMs: Math.round(end - last.end) }),
      },
      until: { scene: "end" },
      reason: "teardown",
    })
  }

  // Interrupts handled off camera (a dismissed popup) are cut too.
  const interruptSpans: Span[] = []
  for (const e of tl.events) {
    if (e.kind !== "interrupt" || e.until <= e.t) continue
    interruptSpans.push({ a: e.t, b: e.until })
    clips.push({
      id: `clip:interrupt:${interruptSpans.length - 1}`,
      source: "auto",
      mode: "cut",
      at: anchorFor(e.t, tl),
      until: anchorFor(e.until, tl),
      reason: "interrupt",
    })
  }

  // A step's own `speed` (the author's choice), except where rule 1 protects it.
  const speedSpans: Span[] = []
  for (const s of tl.steps) {
    if (s.step.speed === undefined || s.step.speed === 1 || s.end <= s.start) continue
    if (isProtected(s)) {
      warnings.push(`step ${s.id}: speed ignored (a caption or pause is never sped up)`)
      continue
    }
    speedSpans.push({ a: s.start, b: s.end })
    clips.push({
      id: `clip:speed:${s.id}`,
      source: "auto",
      mode: "speed",
      speed: s.step.speed,
      at: { step: s.id, edge: "start" },
      until: { step: s.id, edge: "end" },
      reason: "user",
    })
  }

  // Rule 3: idle stretches, between the first step and the end beat, outside what's protected or
  // already sped up by the author.
  // The end beat plays in real time too.
  const busy = mergeSpans([
    ...activity(tl),
    ...protectedSpans,
    ...speedSpans,
    ...interruptSpans,
    { a: last.end, b: end },
  ])
  for (const gap of complement(busy, first.start, end)) {
    const a = gap.a + margin
    const b = gap.b - margin
    if (gap.b - gap.a <= threshold || b <= a) continue
    const speed = Math.min(MAX_SPEED, Math.max(idleSpeed, (b - a) / threshold))
    // A navigation is itself a short busy span: one right before the gap is the page loading.
    const network = tl.events.some(
      (e) =>
        e.kind === "navigate" &&
        e.phase === "steps" &&
        e.t >= gap.a - NAVIGATE_BUSY_MS - 1 &&
        e.t <= gap.b,
    )
    const at = anchorFor(a, tl)
    const until = anchorFor(b, tl)
    clips.push({
      id: `clip:idle:${Math.round(a)}`,
      source: "auto",
      mode: "speed",
      speed: Math.round(speed * 100) / 100,
      at,
      until,
      reason: network ? "network" : "idle",
    })
  }

  // Rule 4 (and `hold`): a freeze at the step end, for reading time and the author's beat.
  for (const s of tl.steps) {
    const reading =
      s.step.caption === undefined
        ? 0
        : Math.max(0, readingTimeMs(s.step.caption) - (s.end - s.start))
    const hold = s.step.hold ?? 0
    const ms = Math.round(reading + hold)
    if (ms <= 0) continue
    clips.push({
      id: `clip:freeze:${s.id}`,
      source: "auto",
      mode: "freeze",
      at: { step: s.id, edge: "end" },
      ms,
      reason: reading > 0 ? "reading" : "user",
    })
  }
  return { clips, warnings }
}

/** When something visibly happens: the cursor moves, a click, keys, typing, a navigation. */
function activity(tl: Timeline): Span[] {
  const spans: Span[] = []
  const samples = tl.cursor
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1]
    const q = samples[i]
    if (p === undefined || q === undefined) continue
    // Samples are only logged while the cursor travels (~60/s): two far apart in time are the end
    // of one move and the start of the next, and the rest between them is idle.
    if (q.t - p.t > 100) continue
    if (p.p.x !== q.p.x || p.p.y !== q.p.y || p.pressed !== q.pressed)
      spans.push({ a: p.t, b: q.t })
  }
  // A scroll moves the page (smooth scrolling) without cursor samples: its step is activity.
  for (const s of tl.steps) if (s.step.action === "scroll") spans.push({ a: s.start, b: s.end })
  const typing = new Map<string, number>()
  for (const e of tl.events) {
    if (e.phase !== "steps") continue
    switch (e.kind) {
      case "click":
        spans.push({ a: e.t - 200, b: e.t + 400 })
        break
      case "key":
        spans.push({ a: e.t - 100, b: e.t + 400 })
        break
      case "navigate":
        spans.push({ a: e.t, b: e.t + NAVIGATE_BUSY_MS })
        break
      case "type_start":
        typing.set(e.stepId ?? "", e.t)
        break
      case "type_end": {
        const start = typing.get(e.stepId ?? "")
        if (start !== undefined) spans.push({ a: start, b: e.t + 300 })
        break
      }
      default:
        break
    }
  }
  return spans
}

function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.b > s.a).sort((x, y) => x.a - y.a)
  const out: Span[] = []
  for (const s of sorted) {
    const prev = out.at(-1)
    if (prev !== undefined && s.a <= prev.b) prev.b = Math.max(prev.b, s.b)
    else out.push({ ...s })
  }
  return out
}

/** The parts of [from, to] not covered by `busy` (sorted, merged). */
function complement(busy: Span[], from: number, to: number): Span[] {
  const out: Span[] = []
  let cursor = from
  for (const s of busy) {
    if (s.b <= cursor) continue
    if (s.a >= to) break
    if (s.a > cursor) out.push({ a: cursor, b: s.a })
    cursor = Math.max(cursor, s.b)
  }
  if (cursor < to) out.push({ a: cursor, b: to })
  return out
}
