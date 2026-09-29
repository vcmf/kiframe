import { describe, expect, it } from "vitest"
import { CAPTURE_LAG_MS, Regions } from "../src/regions.ts"

const base = { phase: "steps" as const, stepId: "a" }
const A = { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }
const B = { x: 0.1, y: 0.5, w: 0.2, h: 0.05 }

describe("Regions (SECRETS-DESIGN §5)", () => {
  it("writes one region per id, covering a move with the hull over [p, s]", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, 100, A)
    r.seen("f", "secret-field", base, 400, A)
    r.seen("f", "secret-field", base, 900, B)
    const [region, ...others] = r.finish(2000)
    expect(others).toEqual([])
    expect(region).toMatchObject({ t: 100, until: 2000, id: "f", why: "secret-field" })
    const [a, hull, b] = region?.boxes ?? []
    expect(a).toEqual({ from: 100, until: 900, rect: A })
    // Between the last measurement at A (400) and the first at B (900): anywhere between.
    expect(hull).toMatchObject({ from: 400, until: 900, rect: { x: 0.1, y: 0.1 } })
    expect(hull?.rect.w).toBeCloseTo(0.2, 9)
    expect(hull?.rect.h).toBeCloseTo(0.45, 9)
    expect(b).toEqual({ from: 900, until: 2000, rect: B })
  })

  it("keeps a gone region for the capture lag, and backdates a return to when it left", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, 100, A)
    r.gone("f", 500)
    r.seen("f", "secret-field", base, 1500, A)
    expect(r.finish(3000)[0]?.boxes).toEqual([
      { from: 100, until: 500 + CAPTURE_LAG_MS, rect: A },
      { from: 500, until: 3000, rect: A },
    ])
  })

  it("never backdates before a page switch, and takes the runtime's own `since`", () => {
    const r = new Regions()
    r.seen("t", "secret-text", base, 100, A)
    r.gone("t", 200)
    r.switched(1000)
    r.seen("t", "secret-text", base, 1200, A)
    r.seen("u", "secret-text", base, 1200, B, 50)
    r.seen("f", "secret-field", base, 1300, A)
    r.gone("f", 1400)
    r.seen("f", "secret-field", base, 2000, A, 1900)
    const [t, u, f] = r.finish(3000)
    expect(t?.boxes.at(-1)?.from).toBe(1000)
    expect(u?.boxes).toEqual([{ from: 1000, until: 3000, rect: B }])
    expect(f?.boxes.at(-1)?.from).toBe(1900)
  })

  it("adds no hull when the old box already holds the new one (a full-frame fallback)", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, 100, { x: 0, y: 0, w: 1, h: 1 })
    r.seen("f", "secret-field", base, 900, B)
    expect(r.finish(2000)[0]?.boxes).toEqual([
      { from: 100, until: 900, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { from: 900, until: 2000, rect: B },
    ])
  })

  it("clamps every box to the end of the scene", () => {
    const r = new Regions()
    r.seen("f", "secret-field", base, 100, A)
    r.gone("f", 1900)
    expect(r.finish(2000)[0]).toMatchObject({ until: 2000, boxes: [{ from: 100, until: 2000 }] })
  })
})
