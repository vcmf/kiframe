import { describe, expect, it } from "vitest"
import {
  checkScenarioAgainstProject,
  Composition,
  NRect,
  parseProjectYaml,
  parseScenarioYaml,
  RectTuple,
  SchemaError,
  TakeEvent,
  TakeMeta,
} from "./index.ts"

// Regression tests for the P0-2 review round 1 findings.
const steps = `steps:\n  - { id: a, action: pause, ms: 1 }\n`
const project = (extra = "") =>
  `version: 1\ntarget:\n  kind: web\n  url: https://staging.acme.com\n  viewport: { width: 1440, height: 900 }\n${extra}`

describe("strictness everywhere (typos are errors)", () => {
  it("rejects a misspelled top-level scenario key", () => {
    expect(() => parseScenarioYaml(`version: 1\nteardwon: []\n${steps}`)).toThrow(/teardwon/)
  })

  it("rejects typos inside project defaults and redaction", () => {
    expect(() => parseProjectYaml(project("defaults: { pacng: { settleMs: 0 } }\n"))).toThrow(
      /pacng/,
    )
    expect(() => parseProjectYaml(project("redaction: { selector: ['.x'] }\n"))).toThrow(/selector/)
  })

  it("keeps composition style, callouts and keystrokes instead of stripping them", () => {
    const c = Composition.parse({
      version: 1,
      style: { background: "#000" },
      tracks: {
        callouts: [
          {
            id: "c",
            source: "manual",
            kind: "text",
            text: "Here",
            at: { ms: 0 },
            until: { ms: 500 },
            target: { rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } },
          },
        ],
        keystrokes: [{ id: "k", source: "auto", keys: "Mod+K", at: { ms: 0 }, until: { ms: 300 } }],
      },
    })
    expect(c.style).toEqual({ background: "#000" })
    expect(c.tracks.callouts).toHaveLength(1)
    expect(c.tracks.keystrokes).toHaveLength(1)
    expect(Composition.safeParse({ version: 1, tracks: {}, extra: 1 }).success).toBe(false)
  })
})

describe("overrides are validated like project settings", () => {
  it("rejects an invalid viewport and unknown override keys", () => {
    expect(() =>
      parseScenarioYaml(`version: 1\noverrides: { viewport: { width: 0 } }\n${steps}`),
    ).toThrow(SchemaError)
    expect(() => parseScenarioYaml(`version: 1\noverrides: { pacng: 1 }\n${steps}`)).toThrow(
      /pacng/,
    )
    expect(
      parseScenarioYaml(`version: 1\noverrides: { pacing: { settleMs: 100 } }\n${steps}`).overrides
        ?.pacing?.settleMs,
    ).toBe(100)
  })
})

describe("camera.until", () => {
  it("must point to a later step", () => {
    const yaml = (until: string) =>
      `version: 1\nsteps:\n  - { id: a, action: pause, ms: 1 }\n  - { id: b, action: pause, ms: 1, camera: { follow: cursor, until: ${until} } }\n  - { id: c, action: pause, ms: 1 }\n`
    expect(() => parseScenarioYaml(yaml("a"))).toThrow(/later step/)
    expect(() => parseScenarioYaml(yaml("b"))).toThrow(/later step/)
    expect(parseScenarioYaml(yaml("c")).steps).toHaveLength(3)
  })
})

describe("ids are unique across setup, steps and teardown", () => {
  it("rejects a setup id that collides with a step id", () => {
    expect(() =>
      parseScenarioYaml(`version: 1\nsetup:\n  - { id: a, action: pause, ms: 1 }\n${steps}`),
    ).toThrow(/duplicate id "a"/)
  })
})

describe("presets", () => {
  it("can't reference other presets (no recursion)", () => {
    expect(() => parseProjectYaml(project("presets:\n  a:\n    steps: [{ preset: a }]\n"))).toThrow(
      SchemaError,
    )
  })

  it("reports scenario references to unknown presets", () => {
    const p = parseProjectYaml(
      project("presets:\n  login:\n    steps: [{ action: goto, url: /login }]\n"),
    )
    const s = parseScenarioYaml(`version: 1\nsetup:\n  - preset: login\n  - preset: logn\n${steps}`)
    expect(checkScenarioAgainstProject(s, p)).toEqual(['setup uses unknown preset "logn"'])
  })
})

describe("take events for off-camera work", () => {
  it("allows setup events without a step id, but requires one on camera", () => {
    expect(
      TakeEvent.safeParse({ t: 0, phase: "setup", kind: "navigate", url: "https://x.test/login" })
        .success,
    ).toBe(true)
    expect(
      TakeEvent.safeParse({ t: 0, phase: "steps", kind: "navigate", url: "https://x.test" })
        .success,
    ).toBe(false)
  })

  it("accepts recordedAt with a timezone offset", () => {
    const meta = {
      version: 1,
      takeKey: "k",
      scenarioHash: "h",
      recordedAt: "2026-09-26T20:00:00+02:00",
      appUrl: "https://x.test",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      frameSize: { width: 2880, height: 1800 },
      fps: 30,
      durationMs: 1000,
      kiframeVersion: "0.0.0",
    }
    expect(TakeMeta.safeParse(meta).success).toBe(true)
  })
})

describe("secret references", () => {
  it.each(["{{secrets.x}}\n", "{{ secrets.x }}", "pw: {{secrets.x}}"])(
    "rejects the malformed reference %j",
    (value) => {
      const yaml = `version: 1\nsteps:\n  - id: t\n    action: type\n    target: { intent: "field" }\n    value: ${JSON.stringify(value)}\n`
      expect(() => parseScenarioYaml(yaml)).toThrow(/malformed secret reference/)
    },
  )
})

describe("geometry and bounds", () => {
  it("rejects zero-area rects", () => {
    expect(NRect.safeParse({ x: 0.5, y: 0.5, w: 0, h: 0.1 }).success).toBe(false)
    expect(RectTuple.safeParse([0.5, 0.5, 0.1, 0]).success).toBe(false)
  })

  it("caps step speed like clip speed", () => {
    expect(() =>
      parseScenarioYaml(`version: 1\nsteps:\n  - { id: a, action: pause, ms: 1, speed: 1000 }\n`),
    ).toThrow(SchemaError)
  })
})

describe("input hygiene", () => {
  it("wraps YAML syntax errors in SchemaError", () => {
    expect(() => parseScenarioYaml("version: 1\nsteps: [\n")).toThrow(SchemaError)
  })

  it("only accepts http(s) target URLs", () => {
    expect(() =>
      parseProjectYaml(project().replace("https://staging.acme.com", "javascript:alert(1)")),
    ).toThrow(SchemaError)
  })
})
