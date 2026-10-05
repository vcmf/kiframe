import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { generate, type TakeInput } from "@kiframe/generators"
import {
  parseProjectYaml,
  parseScenarioYaml,
  type Composition,
  type TakeEvent,
  type TakeMeta,
} from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import { BUILTIN_BACKGROUNDS, DEFAULT_STYLE as SCHEMA_DEFAULT_STYLE } from "@kiframe/schema"
import { coverCrop, drawScene } from "../src/draw.ts"
import { contentBox, cursorAt, prepare, sceneAt, stageTransform } from "../src/scene.ts"

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
    // A secret field, as the recorder writes it: measured at 1.1 s, moved by the next measurement
    // (5 s: the hull covers the way between), on screen until the end.
    {
      t: 1100,
      phase: "steps",
      stepId: "a",
      kind: "sensitive",
      id: "s1",
      why: "secret-field",
      until: 7000,
      boxes: [
        { from: 1100, until: 5000, rect: { x: 0.3, y: 0.3, w: 0.2, h: 0.05 } },
        { from: 1100, until: 5000, rect: { x: 0.3, y: 0.3, w: 0.2, h: 0.25 } },
        { from: 5000, until: 7000, rect: { x: 0.3, y: 0.5, w: 0.2, h: 0.05 } },
      ],
    },
    { t: 1500, phase: "steps", stepId: "a", kind: "step_end" },
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

  it("applies a framing that starts right where a reading freeze ends", () => {
    const { scenario, take, composition } = fixture()
    const edited: Composition = {
      ...composition,
      tracks: {
        ...composition.tracks,
        camera: [
          {
            id: "manual",
            source: "manual",
            at: { step: "b", edge: "start" },
            until: { step: "b", edge: "end" },
            scale: 2,
            focus: { mode: "point", p: { x: 0.8, y: 0.8 } },
          },
        ],
      },
    }
    // Make b start exactly at a's end, where a's reading freeze is.
    const events = take.events.map((e) =>
      e.kind === "step_start" && e.stepId === "b" ? { ...e, t: 1500 } : e,
    )
    const p = prepare(edited, scenario, { ...take, events })
    let max = 1
    for (let t = 0; t <= p.duration; t += 20) max = Math.max(max, sceneAt(p, t).view.scale)
    expect(max).toBeGreaterThan(1.8)
  })

  it("layers styles like resolveStyle: base (org + project), then the scene, then the output", () => {
    const { scenario, take, composition } = fixture()
    const styled: Composition = { ...composition, style: { radius: 4 } }
    const base = { ...SCHEMA_DEFAULT_STYLE, radius: 30, padding: 0.1 }
    const s = prepare(styled, scenario, take, { captionSize: 50 }, base).style
    expect(s).toMatchObject({ radius: 4, padding: 0.1, captionSize: 50 })
  })

  it("fills the frame with the app when there's no background (no padding, no corners)", () => {
    const { scenario, take, composition } = fixture()
    const bare: Composition = { ...composition, style: { background: "none", padding: 0.2 } }
    const s = prepare(bare, scenario, take).style
    expect(s).toMatchObject({ background: "none", padding: 0, radius: 0 })
    // The output's own layer comes last: it can't put a window look back without a background,
    // nor keep the scene's padding when it takes the background away.
    expect(prepare(bare, scenario, take, { padding: 0.1, radius: 9 }).style).toMatchObject({
      padding: 0,
      radius: 0,
    })
    const framedScene: Composition = { ...composition, style: { padding: 0.06 } }
    expect(prepare(framedScene, scenario, take, { background: "none" }).style.padding).toBe(0)
    // A 16:9 take in a 16:9 frame: the whole frame.
    expect(contentBox(s, { width: 1920, height: 1080 })).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })

  it("draws no window look without a background: black around the app, no shadow", () => {
    const { scenario, take, composition } = fixture()
    const drawn = (style: Composition["style"]) => {
      const { ctx, ops } = recorder()
      const prepared = prepare({ ...composition, style }, scenario, take)
      const frame = { width: 1280, height: 800 } as unknown as CanvasImageSource & {
        width: number
        height: number
      }
      drawScene(ctx, frame, sceneAt(prepared, 0), prepared.style)
      return ops
    }
    const bare = drawn({ background: "none" })
    // First, the whole frame black (the bars of an app of another aspect).
    expect(bare.slice(0, 2)).toEqual(["fillStyle=#000", "fillRect(0,0,1920,1080)"])
    // The window's shadow (the cursor keeps its own small one).
    expect(bare.some((o) => o.startsWith("shadowBlur=") && Number(o.slice(11)) >= 48)).toBe(false)
    expect(bare).not.toContain("gradient")
    const framed = drawn({ background: { builtin: "mountain-lake" } })
    expect(framed).toContain("gradient")
    // The whole frame painted, whatever the zoom (never the last frame's pixels left at an edge).
    expect(framed).toContain("fillRect(0,0,1920,1080)")
    expect(
      framed.some((o) => /^shadowBlur=(\d+(\.\d+)?)$/.test(o) && Number(o.slice(11)) >= 48),
    ).toBe(true)
  })

  it("draws the background's image over the whole picture, cropped to its aspect, no gradient", () => {
    const { scenario, take, composition } = fixture()
    const { ctx, ops } = recorder()
    const prepared = prepare(
      { ...composition, style: { background: { builtin: "mountain-lake" } } },
      scenario,
      take,
    )
    const frame = { width: 1280, height: 800 } as unknown as CanvasImageSource & {
      width: number
      height: number
    }
    // A taller image than the 16:9 picture: its middle band, the full width.
    const image = { width: 3840, height: 2880, toString: () => "image" } as unknown as typeof frame
    drawScene(ctx, frame, sceneAt(prepared, 0), prepared.style, image)
    expect(ops).not.toContain("gradient")
    const drawn = ops.find((o) => o.startsWith("drawImage(image,"))
    expect(drawn).toBeDefined()
    const [sx, sy, sw, sh, dx, dy, dw, dh] = numbers(drawn ?? "").slice(1)
    expect([sx, sy, sw, sh]).toEqual([0, 360, 3840, 2160])
    // Over the picture as the camera shows it (zoomed here): the frame covered, edge to edge.
    expect(dx).toBeLessThanOrEqual(0)
    expect(dy).toBeLessThanOrEqual(0)
    expect(dx! + dw!).toBeGreaterThanOrEqual(1920)
    expect(dy! + dh!).toBeGreaterThanOrEqual(1080)
    expect(dw! / dh!).toBeCloseTo(16 / 9)
  })

  it("crops an image to cover a picture (never stretched), centered", () => {
    expect(coverCrop({ width: 3840, height: 2160 }, 1920, 1080)).toEqual({
      sx: 0,
      sy: 0,
      sw: 3840,
      sh: 2160,
    })
    // A vertical output from a landscape image: its middle, the full height.
    expect(coverCrop({ width: 3840, height: 2160 }, 1080, 1920)).toEqual({
      sx: (3840 - 1215) / 2,
      sy: 0,
      sw: 1215,
      sh: 2160,
    })
  })

  it("ships exactly the backgrounds the schema names, each one's file there", () => {
    const dir = join(import.meta.dirname, "..", "backgrounds")
    const list = JSON.parse(readFileSync(join(dir, "backgrounds.json"), "utf8")) as {
      default: string
      backgrounds: { id: string; file: string }[]
    }
    expect(list.backgrounds.map((b) => b.id).sort()).toEqual([...BUILTIN_BACKGROUNDS].sort())
    for (const b of list.backgrounds) expect(existsSync(join(dir, b.file)), b.file).toBe(true)
    expect(SCHEMA_DEFAULT_STYLE.background).toEqual({ builtin: list.default })
  })

  it("keeps the content box valid on vertical outputs, even at the maximum padding", () => {
    const { scenario, take, composition } = fixture()
    const s = prepare(composition, scenario, take, {
      width: 1080,
      height: 1920,
      padding: 0.3,
    }).style
    const box = contentBox(s, { width: 1440, height: 900 })
    expect(box.w).toBeGreaterThan(0)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.w).toBeLessThanOrEqual(1080)
  })

  it("uses the composition's own style, the caller's on top", () => {
    const { scenario, take, composition } = fixture()
    const styled: Composition = {
      ...composition,
      style: { radius: 4, captions: { size: 48 }, cursor: { size: 40 } },
    }
    expect(prepare(styled, scenario, take).style).toMatchObject({
      radius: 4,
      captionSize: 48,
      cursorSize: 40,
    })
    expect(prepare(styled, scenario, take, { radius: 9 }).style.radius).toBe(9)
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

  it("never shows the next step's caption during the previous step's reading freeze", () => {
    const scenario = parseScenarioYaml(
      `version: 1\nsteps:\n${btn("a", `, caption: "A fairly long caption that needs reading time"`)}${btn("b", `, caption: "Then this"`)}`,
    )
    const base = fixture()
    // b starts exactly where a ends, like the recorder logs them.
    const events = base.take.events.map((e) =>
      e.kind === "step_start" && e.stepId === "b" ? { ...e, t: 1500 } : e,
    )
    const take = { ...base.take, events }
    const { composition } = generate(project, scenario, take)
    const p = prepare(composition, scenario, take)
    const freeze = composition.tracks.clips.find((c) => c.mode === "freeze" && c.id.endsWith(":a"))
    expect(freeze).toBeDefined()
    const start = p.map.toOutput(1500)
    const ms = freeze?.mode === "freeze" ? freeze.ms : 0
    for (const u of [1, ms / 2, ms - 1]) {
      expect(sceneAt(p, start + u).captions.map((c) => c.text)).toEqual([
        "A fairly long caption that needs reading time",
      ])
    }
    expect(sceneAt(p, start + ms + 50).captions.map((c) => c.text)).toEqual(["Then this"])
  })

  it("draws a secret region's boxes exactly over their spans, from the take", () => {
    const { scenario, take, composition } = fixture()
    const p = prepare(composition, scenario, take)
    const round = (n: number) => Math.round(n * 1e6) / 1e6
    const at = (source: number) =>
      sceneAt(p, source === 500 ? 0 : p.map.toOutput(source))
        .blurs.map((r) => `${round(r.y)}+${round(r.h)}`)
        .sort()
    expect(at(500)).toEqual([])
    // The old box and the hull of the move, both ends included; then the new box only.
    expect(at(1200)).toEqual(["0.3+0.05", "0.3+0.25"])
    expect(at(5000)).toEqual(["0.3+0.05", "0.3+0.25", "0.5+0.05"])
    expect(at(5400)).toEqual(["0.5+0.05"])
  })

  it("keeps secret regions whatever the composition says (it can only add masks)", () => {
    const { scenario, take, composition } = fixture()
    const edited: Composition = {
      ...composition,
      tracks: {
        ...composition.tracks,
        masks: [
          {
            id: "m",
            source: "manual",
            kind: "blur",
            at: { ms: 5200 },
            until: { ms: 5250 },
            target: { rect: { x: 0, y: 0, w: 0.1, h: 0.1 } },
          },
        ],
      },
    }
    const p = prepare(edited, scenario, take)
    const at = (source: number) => sceneAt(p, p.map.toOutput(source)).blurs.length
    expect(at(1200)).toBe(2)
    expect(at(5400)).toBe(2)
    // After the manual mask and its tail (source 5800): the region only.
    expect(at(6000)).toBe(1)
  })

  it("draws a user's blur naming a region at the region's box of the moment, past its end", () => {
    const { scenario, take, composition } = fixture()
    const withMine: Composition = {
      ...composition,
      tracks: {
        ...composition.tracks,
        masks: [
          {
            id: "mine",
            source: "manual",
            kind: "blur",
            at: { ms: 1000 },
            until: { ms: 6500 },
            target: { sensitiveId: "s1" },
          },
        ],
      },
    }
    const p = prepare(withMine, scenario, take)
    const ys = (source: number) =>
      sceneAt(p, p.map.toOutput(source))
        .blurs.map((r) => Math.round(r.y * 100) / 100)
        .sort()
    // Before the region: its first box; later, its box of the moment (plus the region's own).
    expect(ys(1050)).toEqual([0.3])
    expect(ys(5400)).toEqual([0.5, 0.5])
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

/** A canvas that records what's asked of it: each call with its arguments, each property set. */
function recorder(): { ctx: CanvasRenderingContext2D; ops: string[] } {
  const ops: string[] = []
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) =>
        key === "createLinearGradient"
          ? () => ({ addColorStop: () => ops.push("gradient") })
          : key === "measureText"
            ? (text: string) => ({ width: text.length * 10 })
            : (...args: unknown[]) => ops.push(`${String(key)}(${args.map(String).join(",")})`),
      set: (_t, key, value) => {
        ops.push(`${String(key)}=${String(value)}`)
        return true
      },
    },
  ) as unknown as CanvasRenderingContext2D
  return { ctx, ops }
}
const numbers = (op: string) =>
  op
    .slice(op.indexOf("(") + 1, -1)
    .split(",")
    .map(Number)

describe("the camera over the whole picture (OBJECT-MODEL §0.14)", () => {
  const W = 1920
  const H = 1080
  const zoomed = (style: Composition["style"]) => {
    const { scenario, take, composition } = fixture()
    const p = prepare({ ...composition, style }, scenario, take)
    const frames: { t: number; view: ReturnType<typeof sceneAt>["view"] }[] = []
    for (let t = 0; t <= p.duration; t += 40) frames.push({ t, view: sceneAt(p, t).view })
    return { p, frames, frame: take.meta.frameSize }
  }

  it("shows the whole picture at rest, and never past the background's edges zoomed", () => {
    const { p, frames, frame } = zoomed({ background: { builtin: "mountain-lake" } })
    const rest = stageTransform(p.style, frame, { scale: 1, cx: 0.5, cy: 0.5 })
    expect(rest.out(0, 0)).toEqual({ x: 0, y: 0 })
    expect(rest.out(W, H)).toEqual({ x: W, y: H })
    expect(Math.max(...frames.map((f) => f.view.scale))).toBeGreaterThan(1.5)
    for (const { t, view } of frames) {
      const tr = stageTransform(p.style, frame, view)
      const a = tr.out(0, 0)
      const b = tr.out(W, H)
      expect(a.x <= 1e-6 && a.y <= 1e-6 && b.x >= W - 1e-6 && b.y >= H - 1e-6, `t=${t}`).toBe(true)
    }
  })

  it("without a background, zooms the app only: never an empty border past it", () => {
    const { p, frames, frame } = zoomed({ background: "none" })
    for (const { t, view } of frames) {
      const tr = stageTransform(p.style, frame, view)
      const a = tr.fromApp(0, 0)
      const b = tr.fromApp(1, 1)
      // Larger than the frame on an axis: it covers it; smaller (an app of another aspect): centered.
      if (b.x - a.x >= W) expect(a.x <= 1e-6 && b.x >= W - 1e-6, `t=${t}`).toBe(true)
      else expect(Math.abs(a.x + b.x - W) < 1e-6, `t=${t}`).toBe(true)
      if (b.y - a.y >= H) expect(a.y <= 1e-6 && b.y >= H - 1e-6, `t=${t}`).toBe(true)
      else expect(Math.abs(a.y + b.y - H) < 1e-6, `t=${t}`).toBe(true)
    }
  })

  it("paints the background while a rounded corner of the window is on screen", () => {
    const { p } = zoomed({ background: { builtin: "mountain-lake" } })
    // The window's top-left 2px past the frame's corner: its bounding box covers the frame, its
    // rounded corner doesn't (the arc leaves the corner itself to the background).
    const scale = 2
    const box = contentBox(p.style, p.frame)
    const at = (edge: number, size: number, screen: number) =>
      (edge + (screen / 2 + 2) / scale - edge) / size
    const view = { scale, cx: at(box.x, box.w, W), cy: at(box.y, box.h, H) }
    const tr = stageTransform(p.style, p.frame, view)
    expect(tr.out(box.x, box.y).x).toBeCloseTo(-2, 6)
    const { ctx, ops } = recorder()
    const scene = { ...sceneAt(p, 0), view }
    const frame = { width: 1280, height: 800 } as unknown as CanvasImageSource & {
      width: number
      height: number
    }
    drawScene(ctx, frame, scene, p.style)
    expect(ops).toContain("gradient")
  })

  it("aims each zoom where the camera can go: near an edge, no stall then jump", () => {
    const { scenario, take, composition } = fixture()
    const seg = (id: string, step: string, x: number, y: number) => ({
      id,
      source: "manual" as const,
      at: { step, edge: "start" as const },
      until: { step, edge: "end" as const },
      scale: 2,
      focus: { mode: "rect" as const, rect: { x, y, w: 0.04, h: 0.04 } },
    })
    const edited: Composition = {
      ...composition,
      style: { background: { builtin: "mountain-lake" } },
      tracks: {
        ...composition.tracks,
        camera: [seg("corner", "a", 0, 0), seg("middle", "b", 0.48, 0.48)],
      },
    }
    const p = prepare(edited, scenario, take)
    // Where each move starts, its spring is where the camera shows (never beyond the clamp).
    const later = p.moves.slice(1)
    expect(later.length).toBeGreaterThan(0)
    for (const m of later) {
      const v = sceneAt(p, m.t).view
      expect(Math.abs(m.x0[1] - v.cx), `cx at ${m.t}`).toBeLessThan(0.02)
      expect(Math.abs(m.x0[2] - v.cy), `cy at ${m.t}`).toBeLessThan(0.02)
    }
  })

  it("keeps captions still, and blurs on their fields, at any zoom; the shadow grows with it", () => {
    const { p, frames } = zoomed({ background: { builtin: "mountain-lake" } })
    const frame = { width: 1280, height: 800 } as unknown as CanvasImageSource & {
      width: number
      height: number
    }
    const drawn = (scene: ReturnType<typeof sceneAt>) => {
      const { ctx, ops } = recorder()
      drawScene(ctx, frame, scene, p.style)
      return ops
    }
    const draw = (t: number) => {
      const scene = sceneAt(p, t)
      return { ops: drawn(scene), scene }
    }
    const captions = (ops: string[]) => ops.filter((o) => o.startsWith("fillText("))
    // The same moment with its caption, drawn at rest and zoomed: the caption drawn the same.
    const moment = frames.find((f) => sceneAt(p, f.t).captions.length > 0)
    expect(moment).toBeDefined()
    const shown = sceneAt(p, moment!.t)
    const rest = captions(drawn({ ...shown, view: { scale: 1, cx: 0.5, cy: 0.5 } }))
    expect(rest.length).toBeGreaterThan(0)
    expect(captions(drawn({ ...shown, view: { scale: 2.4, cx: 0.2, cy: 0.3 } }))).toEqual(rest)
    // The secret's blur, while zoomed: where the field is in the window as drawn.
    const blurred = frames.find((f) => f.view.scale > 1.2 && sceneAt(p, f.t).blurs.length > 0)
    expect(blurred).toBeDefined()
    const { ops, scene } = draw(blurred!.t)
    const window = numbers(ops.find((o) => o.startsWith("drawImage(") && numbers(o).length === 9)!)
    const [wx, wy, ww, wh] = window.slice(5)
    const rect = numbers(ops.find((o) => o.startsWith("rect("))!)
    const r = scene.blurs[0]!
    expect(rect[0]).toBeCloseTo(wx! + r.x * ww!, 6)
    expect(rect[1]).toBeCloseTo(wy! + r.y * wh!, 6)
    expect(rect[2]).toBeCloseTo(r.w * ww!, 6)
    expect(rect[3]).toBeCloseTo(r.h * wh!, 6)
    // The window's shadow as large as the window is, at this frame's own zoom (when it shows: the
    // window not covering the whole frame).
    const covers = wx! <= 0 && wy! <= 0 && wx! + ww! >= W && wy! + wh! >= H
    if (!covers) expect(ops).toContain(`shadowBlur=${48 * scene.view.scale}`)
    else
      expect(ops.some((o) => o.startsWith("shadowBlur=") && Number(o.slice(11)) >= 48)).toBe(false)
  })
})
