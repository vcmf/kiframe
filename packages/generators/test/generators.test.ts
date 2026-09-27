import {
  parseProjectYaml,
  parseScenarioYaml,
  type CursorSample,
  type TakeEvent,
  type TakeMeta,
} from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import {
  buildTimeline,
  generate,
  readingTimeMs,
  resolveAnchor,
  timeMap,
  type TakeInput,
} from "../src/index.ts"

const project = (camera = "auto") =>
  parseProjectYaml(`version: 1
target: { kind: web, url: "https://app.example.com", viewport: { width: 1280, height: 800 } }
defaults: { camera: ${camera} }
`)

const scenario = (steps: string) => parseScenarioYaml(`version: 1\nsteps:\n${steps}`)

type Ev = { t: number; kind: TakeEvent["kind"] } & Record<string, unknown>

/** A synthetic take: step spans (ms) plus extra events, all on camera. */
function take(
  spans: [id: string, start: number, end: number][],
  extra: (Ev & { stepId: string })[] = [],
  options: { duration?: number; cursor?: CursorSample[] } = {},
): TakeInput {
  const events = [
    ...spans.flatMap(([id, start, end]) => [
      { t: start, phase: "steps", stepId: id, kind: "step_start" },
      { t: end, phase: "steps", stepId: id, kind: "step_end" },
    ]),
    ...extra.map((e) => ({ phase: "steps", ...e })),
  ].sort((a, b) => a.t - b.t) as TakeEvent[]
  const meta: TakeMeta = {
    version: 1,
    takeKey: "k-1",
    scenarioHash: "h",
    recordedAt: "2026-09-27T00:00:00.000Z",
    appUrl: "https://app.example.com",
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    frameSize: { width: 1280, height: 800 },
    fps: 30,
    durationMs: options.duration ?? (spans.at(-1)?.[2] ?? 0) + 3000,
    kiframeVersion: "0.0.0",
    outcome: { status: "complete" },
  }
  return { meta, events, cursor: options.cursor ?? [] }
}

const click = (stepId: string, t: number, x: number, y: number, w = 0.1, h = 0.05) => ({
  stepId,
  t,
  kind: "click" as const,
  point: { x: x + w / 2, y: y + h / 2 },
  rect: { x, y, w, h },
  button: "left",
})

/** Cursor samples of a move (60/s) ending at `end`, like the recorder logs them. */
const move = (end: number, ms = 300) =>
  Array.from({ length: Math.round(ms / 16) }, (_, i) => ({
    t: end - ms + (i + 1) * 16,
    p: { x: 0.1 + i * 0.01, y: 0.1 },
    pressed: false,
  }))

const btn = (id: string, extra = "") =>
  `  - { id: ${id}, action: click, target: { by: role, role: button, name: ${id} }${extra} }\n`

describe("clips (time model)", () => {
  it("cuts the setup and the teardown, keeping an end beat", () => {
    const s = scenario(btn("a"))
    const t = take([["a", 2000, 3000]], [click("a", 2500, 0.4, 0.4)], { duration: 9000 })
    const { composition } = generate(project(), s, t)
    const { timeline } = buildTimeline(s, t)
    const cuts = composition.tracks.clips.filter((c) => c.mode === "cut")
    expect(cuts.map((c) => c.reason)).toEqual(["setup", "teardown"])
    const map = timeMap(composition.tracks.clips, timeline)
    // 1 s of step + 0.8 s end beat.
    expect(map.outputDuration).toBe(1800)
  })

  it("speeds up long idle stretches, faster when very long, never a caption step", () => {
    const s = scenario(
      btn("a") +
        `  - { id: wait, action: waitFor, until: { text: Done }, caption: "Waiting for the export" }\n` +
        btn("b"),
    )
    const t = take(
      [
        ["a", 0, 1000],
        ["wait", 1000, 9000],
        ["b", 9000, 40_000],
      ],
      [click("a", 500, 0.1, 0.1), click("b", 39_500, 0.1, 0.1)],
      { duration: 40_800 },
    )
    const { composition } = generate(project(), s, t)
    const { timeline } = buildTimeline(s, t)
    const speeds = composition.tracks.clips.filter((c) => c.mode === "speed")
    // Only the idle part of step b (the caption step is protected).
    expect(speeds).toHaveLength(1)
    const map = timeMap(composition.tracks.clips, timeline)
    const out = (id: string, edge: "start" | "end") =>
      map.toOutput(resolveAnchor({ step: id, edge }, timeline) ?? -1)
    // The caption window plays in real time.
    expect(out("wait", "end") - out("wait", "start")).toBe(8000)
    // ~30 s of idle, sped up as far as allowed (16×): under 4 s with the real-time parts around it.
    expect(speeds[0]?.mode === "speed" && speeds[0].speed).toBe(16)
    expect(out("b", "end") - out("b", "start")).toBeLessThan(4000)
  })

  it("speeds up the rest between two cursor moves (real takes have samples)", () => {
    const s = scenario(
      btn("a") + `  - { id: wait, action: waitFor, until: { text: Done } }\n` + btn("b"),
    )
    const t = take(
      [
        ["a", 0, 600],
        ["wait", 600, 10_600],
        ["b", 10_600, 11_600],
      ],
      [click("a", 500, 0.1, 0.1), click("b", 11_500, 0.5, 0.5)],
      { cursor: [...move(500), ...move(11_500)] },
    )
    const speeds = generate(project(), s, t).composition.tracks.clips.filter(
      (c) => c.mode === "speed",
    )
    expect(speeds).toHaveLength(1)
  })

  it("labels the page load after a navigation as network, and cuts interrupts", () => {
    const s = scenario(`  - { id: go, action: goto, url: /reports }\n` + btn("b"))
    const t = take(
      [
        ["go", 0, 5000],
        ["b", 5000, 6000],
      ],
      [
        { stepId: "go", t: 100, kind: "navigate", url: "https://app.example.com/reports" },
        { stepId: "b", t: 5100, kind: "interrupt", rule: "cookie-banner", until: 5400 },
        click("b", 5800, 0.1, 0.1),
      ],
    )
    const clips = generate(project(), s, t).composition.tracks.clips
    expect(clips.find((c) => c.mode === "speed")?.reason).toBe("network")
    expect(clips.some((c) => c.mode === "cut" && c.reason === "interrupt")).toBe(true)
  })

  it("cuts the teardown where it starts, and never speeds up the end beat", () => {
    const s = scenario(btn("a"))
    const t = take(
      [["a", 0, 11_500]],
      [
        click("a", 10_000, 0.1, 0.1),
        { stepId: "cleanup", phase: "teardown", t: 11_510, kind: "step_start" },
        {
          stepId: "cleanup",
          phase: "teardown",
          t: 11_520,
          kind: "navigate",
          url: "https://app.example.com/admin",
        },
      ],
    )
    const { composition } = generate(project(), s, t)
    const { timeline } = buildTimeline(s, t)
    const cut = composition.tracks.clips.find((c) => c.id === "clip:teardown")
    expect(cut && resolveAnchor(cut.at, timeline)).toBeLessThanOrEqual(11_510)
    const idle = composition.tracks.clips.filter((c) => c.mode === "speed")
    expect(idle.every((c) => resolveAnchor(c.until, timeline)! <= 11_500)).toBe(true)
    expect(idle.every((c) => c.reason === "idle")).toBe(true)
  })

  it("freezes at the end of a short caption step for its reading time, plus its hold", () => {
    const caption = "Name the project and press Enter to create it"
    const s = scenario(btn("a", `, caption: "${caption}", hold: 700`))
    const t = take([["a", 0, 1000]], [click("a", 500, 0.4, 0.4)])
    const { composition } = generate(project(), s, t)
    const freeze = composition.tracks.clips.find((c) => c.mode === "freeze")
    expect(freeze).toMatchObject({ at: { step: "a", edge: "end" }, reason: "reading" })
    expect(freeze?.mode === "freeze" && freeze.ms).toBe(readingTimeMs(caption) - 1000 + 700)
  })

  it("ignores a step's speed on a caption step and says so", () => {
    const s = scenario(btn("a", `, caption: Hello, speed: 2`))
    const { composition, warnings } = generate(project(), s, take([["a", 0, 3000]]))
    expect(composition.tracks.clips.some((c) => c.mode === "speed")).toBe(false)
    expect(warnings.join()).toMatch(/speed ignored/)
  })
})

describe("camera", () => {
  it("groups nearby clicks into one framing, and a navigation step zooms out", () => {
    const s = scenario(
      btn("a") + btn("b") + `  - { id: go, action: goto, url: /settings }\n` + btn("c"),
    )
    const t = take(
      [
        ["a", 0, 1000],
        ["b", 1000, 2000],
        ["go", 2000, 3000],
        ["c", 3000, 4000],
      ],
      [click("a", 500, 0.1, 0.1), click("b", 1500, 0.2, 0.12), click("c", 3500, 0.7, 0.7)],
    )
    const { composition } = generate(project(), s, t)
    const cam = composition.tracks.camera
    expect(cam.map((c) => c.id)).toEqual(["camera:a", "camera:c"])
    const { timeline } = buildTimeline(s, t)
    // The first framing ends before the goto step is over (zoom out for the new page).
    expect(resolveAnchor(cam[0]!.until, timeline)).toBeLessThanOrEqual(3000)
    for (const c of cam) expect(c.scale).toBeGreaterThan(1.2)
  })

  it("zooms out during a long wait, and a far-off navigation doesn't stretch the zoom", () => {
    const s = scenario(
      btn("a") +
        `  - { id: wait, action: waitFor, until: { text: Done } }\n` +
        btn("c") +
        `  - { id: enter, action: press, keys: Enter }\n`,
    )
    const t = take(
      [
        ["a", 0, 1000],
        ["wait", 1000, 11_000],
        ["c", 11_000, 12_000],
        ["enter", 20_000, 21_000],
      ],
      [
        click("a", 500, 0.1, 0.1),
        click("c", 11_500, 0.1, 0.1),
        { stepId: "enter", t: 20_200, kind: "navigate", url: "https://app.example.com/x" },
      ],
    )
    // Waits played in real time (no idle speed-up): the zoom can't hold through them.
    const { composition } = generate(project(), s, t, { clips: { idleThresholdMs: 1e9 } })
    const { timeline } = buildTimeline(s, t)
    const ends = composition.tracks.camera.map((c) => resolveAnchor(c.until, timeline)!)
    expect(ends[0]).toBeLessThanOrEqual(1000 + 2500 + 400)
    expect(ends.at(-1)).toBeLessThan(15_000)
  })

  it("keeps one framing across a wait that the clips speed up", () => {
    const s = scenario(btn("a") + btn("b"))
    const t = take(
      [
        ["a", 0, 1000],
        ["b", 7000, 8000],
      ],
      [click("a", 500, 0.1, 0.1), click("b", 7500, 0.15, 0.1)],
    )
    const ids = generate(project(), s, t).composition.tracks.camera.map((c) => c.id)
    expect(ids).toEqual(["camera:a"])
  })

  it("ends a target framing at the step's navigation", () => {
    const s = scenario(btn("a", ", camera: target") + btn("b", ", camera: wide"))
    const t = take(
      [
        ["a", 0, 6000],
        ["b", 6000, 7000],
      ],
      [
        click("a", 500, 0.1, 0.1),
        { stepId: "a", t: 600, kind: "navigate", url: "https://app.example.com/next" },
        click("b", 6500, 0.5, 0.5),
      ],
    )
    const { composition } = generate(project(), s, t)
    const { timeline } = buildTimeline(s, t)
    // No tail or minimum hold into the new page.
    expect(resolveAnchor(composition.tracks.camera[0]!.until, timeline)).toBe(600)
  })

  it("never drops a framing because the next one's lead-in reaches back over it", () => {
    const s = scenario(btn("a", ", camera: target") + btn("b", ", camera: target"))
    const t = take(
      [
        ["a", 300, 600],
        ["b", 600, 900],
      ],
      [click("a", 500, 0.05, 0.05), click("b", 800, 0.85, 0.85)],
    )
    const ids = generate(project(), s, t).composition.tracks.camera.map((c) => c.id)
    expect(ids).toEqual(["camera:a", "camera:b"])
  })

  it("keeps a framing at least ~1.3 s and bridges short zoom-outs", () => {
    const s = scenario(btn("a") + btn("b", ", camera: target"))
    const t = take(
      [
        ["a", 0, 300],
        ["b", 3500, 3800],
      ],
      [click("a", 200, 0.1, 0.1), click("b", 3700, 0.8, 0.8)],
    )
    const { composition } = generate(project(), s, t)
    const { timeline } = buildTimeline(s, t)
    const [first, second] = composition.tracks.camera
    const a0 = resolveAnchor(first!.at, timeline)!
    const a1 = resolveAnchor(first!.until, timeline)!
    expect(a1 - a0).toBeGreaterThanOrEqual(1300)
    // The second framing starts where the first ends: no zoom-out gap under 800 ms.
    const b0 = resolveAnchor(second!.at, timeline)!
    expect(b0 - a1 === 0 || b0 - a1 >= 800).toBe(true)
  })

  it("uses a forced scale, and `wide` has no segment", () => {
    const s = scenario(
      btn("a", ", camera: { frame: target, scale: 2.5 }") + btn("b", ", camera: wide"),
    )
    const t = take(
      [
        ["a", 0, 1000],
        ["b", 5000, 6000],
      ],
      [click("a", 500, 0.1, 0.1), click("b", 5500, 0.5, 0.5)],
    )
    const { composition } = generate(project(), s, t)
    expect(composition.tracks.camera.map((c) => [c.id, c.scale])).toEqual([["camera:a", 2.5]])
  })

  it("frames until a later step, and falls back to wide for another element (not recorded yet)", () => {
    const s = scenario(
      btn("a", ", camera: { follow: cursor, until: c }") +
        btn("b") +
        btn("c") +
        btn("d", ", camera: { frame: { by: text, text: Chart } }"),
    )
    const t = take(
      [
        ["a", 0, 1000],
        ["b", 1000, 2000],
        ["c", 2000, 3000],
        ["d", 3000, 4000],
      ],
      [click("a", 500, 0.1, 0.1), click("b", 1500, 0.1, 0.1), click("d", 3500, 0.1, 0.1)],
    )
    const { composition, warnings } = generate(project(), s, t)
    const { timeline } = buildTimeline(s, t)
    expect(composition.tracks.camera).toHaveLength(1)
    expect(composition.tracks.camera[0]?.focus).toEqual({ mode: "follow-cursor" })
    expect(resolveAnchor(composition.tracks.camera[0]!.until, timeline)).toBeGreaterThanOrEqual(
      3000,
    )
    expect(warnings.join()).toMatch(/kept wide/)
    // (step d is after the `until` span: its own directive applies.)
  })
})

describe("captions, cursor and masks", () => {
  it("anchors a ripple to each click event", () => {
    const s = scenario(btn("a", ", caption: Open it"))
    const t = take([["a", 0, 1000]], [click("a", 640, 0.1, 0.1)])
    const { composition } = generate(project(), s, t)
    const { timeline } = buildTimeline(s, t)
    const ripple = composition.tracks.cursor[0]!
    expect(ripple.kind).toBe("click-ripple")
    expect(resolveAnchor(ripple.at, timeline)).toBe(640)
    expect(composition.tracks.captions[0]).toMatchObject({ id: "caption:a", text: "Open it" })
  })

  it("no ripple on a step with a hidden cursor", () => {
    const s = scenario(btn("a", ", cursor: hide"))
    const t = take([["a", 0, 1000]], [click("a", 500, 0.1, 0.1)])
    const kinds = generate(project(), s, t).composition.tracks.cursor.map((c) => c.kind)
    expect(kinds).toEqual(["hidden"])
  })

  it("a mask never starts late or ends early (rounded outwards)", () => {
    const s = scenario(btn("a"))
    const ev = (t: number, w: number) => ({
      stepId: "a",
      t,
      kind: "sensitive" as const,
      id: "s",
      rect: { x: 0.1, y: 0.1, w, h: w },
      why: "secret-field",
    })
    const t = take([["a", 0, 3000]], [ev(1000.6, 0.1), ev(2000.4, 0)])
    const { composition } = generate(project(), s, t)
    const { timeline } = buildTimeline(s, t)
    const [m] = composition.tracks.masks
    expect(resolveAnchor(m!.at, timeline)).toBeLessThanOrEqual(1000.6)
    expect(resolveAnchor(m!.until, timeline)).toBeGreaterThanOrEqual(2000.4)
  })

  it("shows two ripples for a double click", () => {
    const s = scenario(btn("a", ", count: 2"))
    const t = take([["a", 0, 1000]], [{ ...click("a", 500, 0.1, 0.1), count: 2 }])
    const ids = generate(project(), s, t).composition.tracks.cursor.map((c) => c.id)
    expect(ids).toEqual(["cursor:ripple:a:click", "cursor:ripple:a:click#1"])
  })

  it("blurs a sensitive region until it's gone, and again if it comes back", () => {
    const s = scenario(btn("a") + btn("b"))
    const sensitive = (t: number, w: number) => ({
      stepId: "a",
      t,
      kind: "sensitive" as const,
      id: "secret:acme.password:steps:0",
      rect: { x: 0.3, y: 0.3, w, h: w === 0 ? 0 : 0.05 },
      why: "secret-field",
    })
    const t = take(
      [
        ["a", 0, 1000],
        ["b", 1000, 2000],
      ],
      [sensitive(100, 0.2), sensitive(500, 0.2), sensitive(1000, 0), sensitive(1500, 0.2)],
    )
    const { composition } = generate(project(), s, t)
    const { timeline } = buildTimeline(s, t)
    const masks = composition.tracks.masks.map((m) => [
      resolveAnchor(m.at, timeline),
      resolveAnchor(m.until, timeline),
    ])
    expect(masks).toEqual([
      [100, 1000],
      [1500, t.meta.durationMs],
    ])
  })

  it("uses the recorded order when the scenario was reordered since the take", () => {
    const s = scenario(btn("b") + btn("a"))
    const t = take(
      [
        ["a", 1000, 2000],
        ["b", 2000, 3000],
      ],
      [click("a", 1500, 0.1, 0.1), click("b", 2500, 0.1, 0.1)],
    )
    const { composition } = generate(project(), s, t)
    const { timeline } = buildTimeline(s, t)
    expect(timeline.steps.map((x) => x.id)).toEqual(["a", "b"])
    expect(timeMap(composition.tracks.clips, timeline).outputDuration).toBe(2800)
  })

  it("refuses a failed take and reports steps missing from the take", () => {
    const s = scenario(btn("a") + btn("b"))
    const t = take([["a", 0, 1000]])
    expect(generate(project(), s, t).warnings.join()).toMatch(/step b isn't in the take/)
    t.meta.outcome = { status: "failed", error: "x" }
    expect(() => generate(project(), s, t)).toThrow(/failed take/)
  })
})
