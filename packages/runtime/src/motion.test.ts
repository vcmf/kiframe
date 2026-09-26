import { describe, expect, it } from "vitest"
import { clickPoint, movementDuration, planPath, seededRandom, typingDelays } from "./motion.ts"

const viewport = { width: 1280, height: 800 }

describe("seededRandom", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = seededRandom("steps:open-new:cursor")
    const b = seededRandom("steps:open-new:cursor")
    const c = seededRandom("steps:other:cursor")
    const seqA = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(seqA)
    expect([c(), c(), c()]).not.toEqual(seqA)
    for (const v of seqA) expect(v).toBeGreaterThanOrEqual(0)
  })
})

describe("movementDuration (Fitts's law)", () => {
  it("grows with distance, shrinks with target size, and stays in range", () => {
    expect(movementDuration(800, 40, "natural")).toBeGreaterThan(
      movementDuration(100, 40, "natural"),
    )
    expect(movementDuration(400, 10, "natural")).toBeGreaterThan(
      movementDuration(400, 200, "natural"),
    )
    expect(movementDuration(5000, 1, "natural")).toBeLessThanOrEqual(1200)
    expect(movementDuration(20, 400, "natural")).toBeGreaterThanOrEqual(200)
    expect(movementDuration(400, 40, "fast")).toBeLessThan(movementDuration(400, 40, "natural"))
    expect(movementDuration(400, 40, "instant")).toBe(0)
  })
})

describe("planPath", () => {
  const from = { x: 100, y: 700 }
  const to = { x: 1100, y: 120 }
  const plan = (seed: string, pacing: "natural" | "fast" | "instant" = "natural") =>
    planPath(from, to, { pacing, targetWidth: 80, viewport, random: seededRandom(seed) })

  it("ends exactly on the target, with increasing time", () => {
    const path = plan("a")
    expect(path.at(-1)).toMatchObject(to)
    for (let i = 1; i < path.length; i++) expect(path[i]!.t).toBeGreaterThan(path[i - 1]!.t)
  })

  it("is the same for the same seed, different for another", () => {
    expect(plan("a")).toEqual(plan("a"))
    expect(plan("a")).not.toEqual(plan("b"))
  })

  it("curves (doesn't follow the straight line) and overshoots long moves", () => {
    const path = plan("a")
    const deviation = Math.max(
      ...path.map((p) => {
        // distance from the straight line from→to
        const dx = to.x - from.x
        const dy = to.y - from.y
        return Math.abs(dy * p.x - dx * p.y + to.x * from.y - to.y * from.x) / Math.hypot(dx, dy)
      }),
    )
    expect(deviation).toBeGreaterThan(20)
    const beyond = path.some((p) => p.x > to.x + 3)
    expect(beyond).toBe(true)
  })

  it("stays inside the viewport", () => {
    const edge = planPath(
      { x: 5, y: 5 },
      { x: 1275, y: 795 },
      { pacing: "natural", targetWidth: 10, viewport, random: seededRandom("e") },
    )
    for (const p of edge) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(viewport.width - 1)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(viewport.height - 1)
    }
  })

  it("jumps with instant pacing, clamped to the viewport too", () => {
    expect(plan("a", "instant")).toEqual([{ t: 0, ...to }])
    const off = planPath(
      from,
      { x: 1400, y: 900 },
      { pacing: "instant", targetWidth: 10, viewport, random: seededRandom("o") },
    )
    expect(off).toEqual([{ t: 0, x: 1279, y: 799 }])
  })
})

describe("clickPoint", () => {
  it("lands inside the target, away from the edges", () => {
    const box = { x: 100, y: 200, width: 120, height: 40 }
    const random = seededRandom("click")
    for (let i = 0; i < 100; i++) {
      const p = clickPoint(box, random)
      expect(p.x).toBeGreaterThanOrEqual(box.x + box.width * 0.25)
      expect(p.x).toBeLessThanOrEqual(box.x + box.width * 0.75)
      expect(p.y).toBeGreaterThanOrEqual(box.y + box.height * 0.25)
      expect(p.y).toBeLessThanOrEqual(box.y + box.height * 0.75)
    }
  })
})

describe("typingDelays", () => {
  it("is deterministic, slower after spaces and punctuation, and zero when instant", () => {
    const text = "Hello world. Next"
    const a = typingDelays(text, "human", seededRandom("t"))
    expect(typingDelays(text, "human", seededRandom("t"))).toEqual(a)
    expect(a).toHaveLength(text.length)
    const afterPeriod = a[text.indexOf(".") + 1]!
    const plain = a[1]!
    expect(afterPeriod).toBeGreaterThan(plain)
    expect(typingDelays(text, "instant", seededRandom("t")).every((d) => d === 0)).toBe(true)
    const fast = typingDelays(text, "fast", seededRandom("t"))
    expect(fast.reduce((s, d) => s + d, 0)).toBeLessThan(a.reduce((s, d) => s + d, 0))
  })
})
