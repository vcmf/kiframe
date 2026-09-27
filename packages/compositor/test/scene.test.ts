import { generate, type TakeInput } from "@kiframe/generators"
import {
  parseProjectYaml,
  parseScenarioYaml,
  type Composition,
  type TakeEvent,
  type TakeMeta,
} from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import { cursorAt, prepare, sceneAt } from "../src/scene.ts"

const project = parseProjectYaml(`version: 1
target: { kind: web, url: "https://app.example.com", viewport: { width: 1280, height: 800 } }
`)

const btn = (id: string, extra = "") =>
  `  - { id: ${id}, action: click, target: { by: role, role: button, name: ${id} }${extra} }\n`

/** A take: steps a (0.5–1.5 s, click top-left) and b (4–5 s, click bottom-right), setup before. */
function fixture(extra: string = "") {
  const scenario = parseScenarioYaml(
    `version: 1\nsteps:\n${btn("a", `, caption: "Open the menu"${extra}`)}${btn("b")}`,
  )
  const click = (stepId: string, t: number, x: number, y: number) => ({
    t,
    phase: "steps",
    stepId,
    kind: "click",
    point: { x: x + 0.05, y: y + 0.025 },
    rect: { x, y, w: 0.1, h: 0.05 },
    button: "left",
  })
  const events = [
    { t: 500, phase: "steps", stepId: "a", kind: "step_start" },
    click("a", 1000, 0.1, 0.1),
    {
      t: 1100,
      phase: "steps",
      stepId: "a",
      kind: "sensitive",
      id: "s1",
      rect: { x: 0.3, y: 0.3, w: 0.2, h: 0.05 },
      why: "secret-field",
    },
    { t: 1500, phase: "steps", stepId: "a", kind: "step_end" },
    {
      t: 3000,
      phase: "steps",
      stepId: "a",
      kind: "sensitive",
      id: "s1",
      rect: { x: 0.3, y: 0.5, w: 0.2, h: 0.05 },
      why: "secret-field",
    },
    { t: 4000, phase: "steps", stepId: "b", kind: "step_start" },
    click("b", 4500, 0.8, 0.8),
    { t: 5000, phase: "steps", stepId: "b", kind: "step_end" },
  ] as TakeEvent[]
  const move = (end: number, from: number, to: number) =>
    Array.from({ length: 20 }, (_, i) => ({
      t: end - 320 + (i + 1) * 16,
      p: { x: from + ((to - from) * (i + 1)) / 20, y: from + ((to - from) * (i + 1)) / 20 },
      pressed: false,
    }))
  const meta: TakeMeta = {
    version: 1,
    takeKey: "k",
    scenarioHash: "h",
    recordedAt: "2026-09-27T00:00:00.000Z",
    appUrl: "https://app.example.com",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    frameSize: { width: 1280, height: 800 },
    fps: 60,
    durationMs: 7000,
    kiframeVersion: "0",
    outcome: { status: "complete" },
  }
  const take: TakeInput = {
    meta,
    events,
    cursor: [...move(1000, 0.5, 0.15), ...move(4500, 0.15, 0.85)],
  }
  const { composition } = generate(project, scenario, take)
  return { scenario, take, composition }
}

describe("time mapping", () => {
  it("maps output time back to source time through cuts, speed-ups and freezes", () => {
    const { scenario, take, composition } = fixture()
    const p = prepare(composition, scenario, take)
    // The setup is cut: output 0 shows the first step's start.
    expect(sceneAt(p, 0).sourceT).toBe(500)
    for (let t = 0; t < p.duration; t += 37) {
      const s = sceneAt(p, t).sourceT
      // Round trip (outside freezes, where many output times show one source time).
      if (!p.map.toSource(t).frozen) expect(Math.abs(p.map.toOutput(s) - t)).toBeLessThan(1e-6)
    }
    // Source time never goes backwards.
    let last = -1
    for (let t = 0; t <= p.duration; t += 10) {
      const s = sceneAt(p, t).sourceT
      expect(s).toBeGreaterThanOrEqual(last)
      last = s
    }
  })
})

describe("camera", () => {
  it("moves continuously (no jumps) and settles on the framing", () => {
    const { scenario, take, composition } = fixture()
    const p = prepare(composition, scenario, take)
    expect(composition.tracks.camera.length).toBeGreaterThan(0)
    let prev = sceneAt(p, 0).view
    let maxScale = 1
    for (let t = 5; t <= p.duration; t += 5) {
      const v = sceneAt(p, t).view
      // At most a small step per 5 ms: a spring, never a cut.
      expect(Math.abs(v.cx - prev.cx)).toBeLessThan(0.02)
      expect(Math.abs(Math.log(v.scale) - Math.log(prev.scale))).toBeLessThan(0.05)
      maxScale = Math.max(maxScale, v.scale)
      prev = v
    }
    expect(maxScale).toBeGreaterThan(1.3)
  })

  it("is random-access: seeking gives the same view as playing through", () => {
    const { scenario, take, composition } = fixture()
    const p = prepare(composition, scenario, take)
    const t = p.duration * 0.37
    const direct = sceneAt(p, t)
    for (let u = 0; u < t; u += 33) sceneAt(p, u)
    expect(sceneAt(p, t)).toEqual(direct)
  })

  it("caps the zoom and reports the softness", () => {
    const { scenario, take, composition } = fixture()
    const forced: Composition = {
      ...composition,
      tracks: {
        ...composition.tracks,
        camera: composition.tracks.camera.map((c) => ({ ...c, scale: 4 })),
      },
    }
    const p = prepare(forced, scenario, take, { maxScale: 2.5 })
    let max = 1
    for (let t = 0; t <= p.duration; t += 20) max = Math.max(max, sceneAt(p, t).view.scale)
    expect(max).toBeLessThanOrEqual(2.5)
    // 2.5× of a 1280 px capture drawn ~1520 px wide: ~3 output px per source px.
    expect(p.softness).toBeCloseTo((2.5 * 1520.64) / 1280, 2)
  })
})

describe("overlays", () => {
  it("keeps the caption on screen during its reading freeze", () => {
    const { scenario, take, composition } = fixture()
    const p = prepare(composition, scenario, take)
    const freeze = composition.tracks.clips.find((c) => c.mode === "freeze")
    expect(freeze).toBeDefined()
    // In the middle of the freeze at the end of step a (source 1500).
    const start = p.map.toOutput(1500)
    const mid = sceneAt(p, start + (freeze?.mode === "freeze" ? freeze.ms / 2 : 0))
    expect(mid.sourceT).toBe(1500)
    expect(mid.captions.map((c) => c.text)).toEqual(["Open the menu"])
  })

  it("blurs the sensitive region at its latest rect", () => {
    const { scenario, take, composition } = fixture()
    const p = prepare(composition, scenario, take)
    const round = (n: number) => Math.round(n * 1e6) / 1e6
    const at = (source: number) =>
      sceneAt(p, p.map.toOutput(source)).blurs.map((r) => ({
        x: round(r.x),
        y: round(r.y),
        w: round(r.w),
        h: round(r.h),
      }))
    expect(at(1200)).toEqual([{ x: 0.3, y: 0.3, w: 0.2, h: 0.05 }])
    expect(at(4200)).toEqual([{ x: 0.3, y: 0.5, w: 0.2, h: 0.05 }])
  })

  it("shows a ripple at the click, and the cursor rests between moves", () => {
    const { scenario, take, composition } = fixture()
    const p = prepare(composition, scenario, take)
    const scene = sceneAt(p, p.map.toOutput(1000) + 100)
    expect(scene.ripples).toHaveLength(1)
    expect(scene.ripples[0]?.progress).toBeCloseTo(0.2, 1)
    const rest = cursorAt(p.timeline, 2500)
    expect(rest?.x).toBeCloseTo(0.15, 5)
  })
})
