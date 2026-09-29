import { describe, expect, it } from "vitest"
import { FRAME_MARGIN_MS as M, Regions } from "../src/regions.ts"

const base = { phase: "steps" as const, stepId: "a" }
const A = { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }
const B = { x: 0.1, y: 0.5, w: 0.2, h: 0.05 }
const read = (start: number, end = start) => ({ start, end })

describe("Regions (SECRETS-DESIGN §5 T2–T4)", () => {
  it("writes one region per id, covering a move with the hull from the previous read", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, read(100), A)
    r.seen("f", "secret-field", base, read(400, 420), A)
    r.seen("f", "secret-field", base, read(900, 950), B)
    const [region, ...others] = r.finish(2000)
    expect(others).toEqual([])
    expect(region).toMatchObject({ t: 100 - M, until: 2000, id: "f", why: "secret-field" })
    const [a, hull, b] = region?.boxes ?? []
    // Left at the read's end: until the first frame at or after end + margin (frames at once here).
    expect(a).toEqual({ from: 100 - M, until: 950 + M, rect: A })
    expect(hull).toMatchObject({ from: 400 - M, until: 950 + M, rect: { x: 0.1, y: 0.1 } })
    expect(hull?.rect.h).toBeCloseTo(0.45, 9)
    expect(b).toEqual({ from: 400 - M, until: 2000, rect: B })
  })

  it("leaves a gone box at the read's end, and backdates a return to the previous read", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, read(100), A)
    r.gone("f", read(500, 530))
    r.seen("f", "secret-field", base, read(1500), A)
    expect(r.finish(3000)[0]?.boxes).toEqual([
      { from: 100 - M, until: 530 + M, rect: A },
      { from: 500 - M, until: 3000, rect: A },
    ])
  })

  it("keeps a left box until the first frame at or after end + margin, rounded up", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, read(100), A)
    r.gone("f", read(1000, 1010))
    const frames = [1040.2, 1100.4, 4000]
    const after = (t: number) => frames.find((f) => f >= t)
    expect(r.finish(5000, after)[0]?.boxes).toEqual([{ from: 100 - M, until: 1101, rect: A }])
    // No frame after it: until the end of the scene (the video holds the last one).
    const s = new Regions()
    s.seen("f", "secret-field", base, read(100), A)
    s.gone("f", read(1000))
    expect(s.finish(5000, () => undefined)[0]?.until).toBe(5000)
  })

  it("never backdates before a page switch, and takes the runtime's own `since`", () => {
    const r = new Regions()
    r.seen("t", "secret-text", base, read(100), A)
    r.gone("t", read(200))
    r.switched(1000)
    r.seen("t", "secret-text", base, read(1200), A)
    r.seen("u", "secret-text", base, read(1200), B, 50)
    r.seen("f", "secret-field", base, read(1300), A)
    r.gone("f", read(1400))
    r.seen("f", "secret-field", base, read(2000), A, 1900)
    const [t, u, f] = r.finish(3000)
    expect(t?.boxes.at(-1)?.from).toBe(1000)
    expect(u?.boxes).toEqual([{ from: 1000, until: 3000, rect: B }])
    expect(f?.boxes.at(-1)?.from).toBe(1900 - M)
  })

  it("lets an older read only add coverage, never replace the box", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, read(1000), B)
    // A read that started before, delivered after, saw the field at A.
    r.seen("f", "secret-field", base, read(900, 1050), A)
    r.gone("f", read(800))
    const boxes = r.finish(3000)[0]?.boxes ?? []
    expect(boxes).toContainEqual({ from: 900 - M, until: 1050 + M, rect: A })
    expect(boxes).toContainEqual({ from: 1000 - M, until: 3000, rect: B })
  })

  it("adds no hull when the old box already holds the new one (a full-frame fallback)", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, read(100), { x: 0, y: 0, w: 1, h: 1 })
    r.seen("f", "secret-field", base, read(900), B)
    expect(r.finish(2000)[0]?.boxes).toEqual([
      { from: 100 - M, until: 900 + M, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { from: 100 - M, until: 2000, rect: B },
    ])
  })

  it("never writes an inverted box when the clock steps back", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, read(1000), A)
    r.seen("f", "secret-field", base, read(1200, 1100), B)
    r.gone("f", read(1300, 1250))
    const [region] = r.finish(3000)
    for (const box of region?.boxes ?? []) expect(box.until).toBeGreaterThanOrEqual(box.from)
  })

  it("clamps every box to the end of the scene", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, read(100), A)
    r.gone("f", read(1990))
    expect(r.finish(2000)[0]).toMatchObject({
      until: 2000,
      boxes: [{ from: 100 - M, until: 2000 }],
    })
  })
})
