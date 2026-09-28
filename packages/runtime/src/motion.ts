// Human-like motion (docs/OBJECT-MODEL.md §3): cursor paths and typing rhythm. Everything is
// driven by a seeded random generator, so the same scenario replays the same motion (stable takes).

export interface Point {
  x: number
  y: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** A cursor position at time `t` (ms from the start of the movement). */
export interface PathSample extends Point {
  t: number
}

export type CursorPacing = "natural" | "fast" | "instant"
export type TypingPacing = "human" | "fast" | "instant"

/** Small deterministic PRNG (mulberry32). */
export function seededRandom(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  let a = h >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A point inside the target to click: near the center, never on the edge (padding = 25% of each
 * side), slightly off-center like a human, and deterministic for a given seed.
 */
export function clickPoint(box: Box, random: () => number): Point {
  const spread = (size: number) => (random() - 0.5) * size * 0.5
  return {
    x: box.x + box.width / 2 + spread(box.width),
    y: box.y + box.height / 2 + spread(box.height),
  }
}

/**
 * Movement duration from Fitts's law, T = a + b·log2(D/W + 1): long moves and small targets take
 * longer. Clamped to a range that reads well on video.
 */
export function movementDuration(
  distance: number,
  targetWidth: number,
  pacing: CursorPacing,
): number {
  if (pacing === "instant" || distance < 1) return 0
  const width = Math.max(8, targetWidth)
  const natural = 120 + 160 * Math.log2(distance / width + 1)
  const scale = pacing === "fast" ? 0.5 : 1
  return Math.round(Math.min(1200, Math.max(200, natural)) * scale)
}

const cubic = (p0: number, p1: number, p2: number, p3: number, u: number) =>
  (1 - u) ** 3 * p0 + 3 * (1 - u) ** 2 * u * p1 + 3 * (1 - u) * u ** 2 * p2 + u ** 3 * p3

/** Ease-in-out: slow start, fast middle, slow arrival. */
const easeInOut = (u: number) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2)

export interface PlanOptions {
  pacing: CursorPacing
  /** Width of the target, for Fitts's law. */
  targetWidth: number
  /** The path stays inside the viewport's pixels, [0, width-1] × [0, height-1]. */
  viewport: { width: number; height: number }
  random: () => number
  /** Samples per second. Default 60. */
  fps?: number
  /** Land a little past the target on long moves, then correct. Default true (never while dragging). */
  overshoot?: boolean
}

/**
 * Plans a human-like cursor path from `from` to `to`: a cubic Bézier curve whose control points
 * are both on the same side of the straight line (a gentle arc, like ghost-cursor), eased, with a
 * small overshoot and correction on long moves. Returns timed samples; the last one is exactly `to`.
 */
export function planPath(from: Point, to: Point, options: PlanOptions): PathSample[] {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const distance = Math.hypot(dx, dy)
  const duration = movementDuration(distance, options.targetWidth, options.pacing)
  // Pixels are 0..width-1 and 0..height-1: clamp inside them, for every pacing (instant too).
  const clamp = (p: Point): Point => ({
    x: Math.min(options.viewport.width - 1, Math.max(0, p.x)),
    y: Math.min(options.viewport.height - 1, Math.max(0, p.y)),
  })
  if (duration === 0) return [{ t: 0, ...clamp(to) }]

  const { random } = options
  // Arc: both control points on one side, bending by up to ~20% of the distance.
  const side = random() < 0.5 ? -1 : 1
  const bend = distance * (0.08 + random() * 0.12) * side
  const nx = -dy / distance
  const ny = dx / distance
  const c1 = { x: from.x + dx * 0.3 + nx * bend, y: from.y + dy * 0.3 + ny * bend }
  const c2 = { x: from.x + dx * 0.7 + nx * bend, y: from.y + dy * 0.7 + ny * bend }

  // Overshoot on long moves: land a little past the target, then correct.
  const overshoot = distance > 500 && options.pacing === "natural" && options.overshoot !== false
  const past = overshoot
    ? {
        x: to.x + (dx / distance) * (8 + random() * 10),
        y: to.y + (dy / distance) * (8 + random() * 10),
      }
    : to
  const mainDuration = overshoot ? Math.round(duration * 0.85) : duration

  const fps = options.fps ?? 60
  const frame = 1000 / fps
  const samples: PathSample[] = []
  for (let t = frame; t < mainDuration; t += frame) {
    const u = easeInOut(t / mainDuration)
    samples.push({
      t: Math.round(t),
      ...clamp({
        x: cubic(from.x, c1.x, c2.x, past.x, u),
        y: cubic(from.y, c1.y, c2.y, past.y, u),
      }),
    })
  }
  if (overshoot) {
    samples.push({ t: mainDuration, ...clamp(past) })
    const correction = duration - mainDuration
    for (let t = frame; t < correction; t += frame) {
      const u = easeInOut(t / correction)
      samples.push({
        t: Math.round(mainDuration + t),
        ...clamp({ x: past.x + (to.x - past.x) * u, y: past.y + (to.y - past.y) * u }),
      })
    }
  }
  samples.push({ t: duration, ...clamp(to) })
  return samples
}

/**
 * Delay before each character of on-camera typing: a base rhythm with jitter, longer after a
 * space or punctuation (words and sentences), and a rare hesitation. Deterministic for a seed.
 */
export function typingDelays(text: string, pacing: TypingPacing, random: () => number): number[] {
  if (pacing === "instant") return [...text].map(() => 0)
  const base = pacing === "fast" ? 25 : 70
  const jitter = pacing === "fast" ? 15 : 50
  const chars = [...text]
  return chars.map((_, i) => {
    const previous = chars[i - 1] ?? ""
    let delay = base + random() * jitter
    if (previous === " ") delay += pacing === "fast" ? 10 : 40
    if (/[.,;:!?]/.test(previous)) delay += pacing === "fast" ? 20 : 120
    if (pacing === "human" && random() < 0.03) delay += 150 + random() * 150
    return Math.round(delay)
  })
}
