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

// ─── Round 2 ─────────────────────────────────────────────────────────────────

describe("round 2: overrides don't re-fill defaults", () => {
  it("keeps only the fields the override sets", () => {
    const s = parseScenarioYaml(
      `version: 1\noverrides: { pacing: { settleMs: 100 }, viewport: { width: 800 } }\n${steps}`,
    )
    expect(s.overrides?.pacing).toEqual({ settleMs: 100 })
    expect(s.overrides?.viewport).toEqual({ width: 800 })
  })

  it("rejects `until` in project and scene camera defaults", () => {
    expect(() =>
      parseProjectYaml(project("defaults: { camera: { follow: cursor, until: foo } }\n")),
    ).toThrow(SchemaError)
    expect(() =>
      parseScenarioYaml(
        `version: 1\noverrides: { camera: { follow: cursor, until: z } }\n${steps}`,
      ),
    ).toThrow(SchemaError)
  })
})

describe("round 2: preset names and ids", () => {
  it("doesn't treat prototype keys as existing presets", () => {
    const p = parseProjectYaml(project())
    const s = parseScenarioYaml(`version: 1\nsetup:\n  - preset: constructor\n${steps}`)
    expect(checkScenarioAgainstProject(s, p)).toEqual(['setup uses unknown preset "constructor"'])
  })

  it("rejects __proto__ as a preset name and duplicate ids inside a preset", () => {
    expect(() =>
      parseProjectYaml(
        project('presets:\n  "__proto__":\n    steps: [{ action: goto, url: /x }]\n'),
      ),
    ).toThrow(SchemaError)
    expect(() =>
      parseProjectYaml(
        project(
          "presets:\n  p:\n    steps:\n      - { id: a, action: goto, url: /x }\n      - { id: a, action: goto, url: /y }\n",
        ),
      ),
    ).toThrow(/duplicate id "a"/)
  })

  it("rejects duplicate segment ids across tracks", () => {
    const seg = { id: "c", source: "auto", at: { ms: 0 }, until: { ms: 10 } }
    expect(
      Composition.safeParse({
        version: 1,
        tracks: {
          clips: [
            { ...seg, mode: "cut" },
            { ...seg, mode: "cut" },
          ],
        },
      }).success,
    ).toBe(false)
  })
})

describe("round 2: secrets", () => {
  it.each(["{{secret.x}}", "{{Secrets.x}}", "{{secretsx}}", "{{secrets..}}"])(
    "rejects %j as a type value",
    (value) => {
      const yaml = `version: 1\nsteps:\n  - id: t\n    action: type\n    target: { intent: "field" }\n    value: ${JSON.stringify(value)}\n`
      expect(() => parseScenarioYaml(yaml)).toThrow(SchemaError)
    },
  )

  it("rejects secret references outside `type.value`", () => {
    expect(() =>
      parseScenarioYaml(
        `version: 1\nsteps:\n  - { id: g, action: goto, url: "https://x/?t={{secrets.x}}" }\n`,
      ),
    ).toThrow(/only allowed/)
    expect(() =>
      parseScenarioYaml(
        `version: 1\nsteps:\n  - { id: p, action: pause, ms: 1, caption: "{{secrets.x}}" }\n`,
      ),
    ).toThrow(/only allowed/)
  })

  it("rejects credentials embedded in the target URL", () => {
    expect(() =>
      parseProjectYaml(project().replace("https://staging.acme.com", "https://user:pass@x.com")),
    ).toThrow(/credentials/)
  })
})

describe("round 2: time spans", () => {
  it("rejects inverted interrupt spans and ms-anchored segments", () => {
    expect(
      TakeEvent.safeParse({ t: 100, phase: "steps", kind: "interrupt", rule: "r", until: 50 })
        .success,
    ).toBe(false)
    expect(
      Composition.safeParse({
        version: 1,
        tracks: {
          clips: [{ id: "c", source: "auto", mode: "cut", at: { ms: 100 }, until: { ms: 50 } }],
        },
      }).success,
    ).toBe(false)
  })

  it("allows an on-camera interrupt between steps without a step id", () => {
    expect(
      TakeEvent.safeParse({ t: 0, phase: "steps", kind: "interrupt", rule: "r", until: 5 }).success,
    ).toBe(true)
  })
})

describe("round 2: target-only presentation", () => {
  it("rejects camera: target and emphasis on steps without a target", () => {
    expect(() =>
      parseScenarioYaml(
        `version: 1\nsteps:\n  - { id: p, action: pause, ms: 1, camera: target }\n`,
      ),
    ).toThrow(/no target/)
    expect(() =>
      parseScenarioYaml(
        `version: 1\nsteps:\n  - { id: p, action: press, keys: Enter, emphasis: highlight }\n`,
      ),
    ).toThrow(/no target/)
  })
})

// ─── Round 3 ─────────────────────────────────────────────────────────────────

describe("round 3: errors are always SchemaError", () => {
  it("reports a malformed target URL instead of throwing TypeError", () => {
    for (const url of ["staging.acme.com", "not a url"]) {
      expect(() => parseProjectYaml(project().replace("https://staging.acme.com", url))).toThrow(
        SchemaError,
      )
    }
  })

  it("wraps unresolved and excessive YAML aliases", () => {
    expect(() => parseScenarioYaml("version: 1\nsteps: *nope\n")).toThrow(SchemaError)
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x]",
      ...Array.from({ length: 8 }, (_, i) => {
        const prev = String.fromCharCode(97 + i)
        const next = String.fromCharCode(98 + i)
        return `${next}: &${next} [*${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}]`
      }),
    ].join("\n")
    expect(() => parseScenarioYaml(bomb)).toThrow(SchemaError)
  })
})

describe("round 3: observed rects", () => {
  it("accepts rects partly off screen or collapsed in take events", () => {
    const e = {
      t: 0,
      phase: "steps",
      stepId: "a",
      kind: "sensitive",
      id: "pw",
      why: "secret-field",
    }
    expect(TakeEvent.safeParse({ ...e, rect: { x: 0.2, y: -0.05, w: 0.3, h: 0.1 } }).success).toBe(
      true,
    )
    expect(TakeEvent.safeParse({ ...e, rect: { x: 0.2, y: 0.3, w: 0.3, h: 0 } }).success).toBe(true)
  })
})

describe("round 3: cross-file ids and rule ids", () => {
  it("reports preset step ids that collide with scenario ids", () => {
    const p = parseProjectYaml(
      project("presets:\n  p:\n    steps: [{ id: a, action: goto, url: /x }]\n"),
    )
    const s = parseScenarioYaml(`version: 1\nsetup:\n  - preset: p\n${steps}`)
    expect(checkScenarioAgainstProject(s, p)).toEqual([
      'preset "p" step id "a" collides with an id in the scenario',
    ])
  })

  it("requires an id on interrupt rules", () => {
    expect(() =>
      parseProjectYaml(
        project("interrupts:\n  - when: { text: Hi }\n    do: { action: press, keys: Escape }\n"),
      ),
    ).toThrow(SchemaError)
  })

  it("validates preset references as names at parse time", () => {
    expect(() => parseScenarioYaml(`version: 1\nsetup:\n  - preset: Login\n${steps}`)).toThrow(
      SchemaError,
    )
  })
})

describe("round 3: secrets and credentials in every author string", () => {
  it("rejects credentials in goto URLs but allows relative URLs", () => {
    expect(() =>
      parseScenarioYaml(
        `version: 1\nsteps:\n  - { id: g, action: goto, url: "https://u:p@x.com" }\n`,
      ),
    ).toThrow(/credentials/)
    expect(
      parseScenarioYaml(`version: 1\nsteps:\n  - { id: g, action: goto, url: /projects }\n`).steps,
    ).toHaveLength(1)
  })

  it("rejects secret references in locators, intents and composition captions", () => {
    const click = (target: string) =>
      `version: 1\nsteps:\n  - { id: c, action: click, target: ${target} }\n`
    expect(() => parseScenarioYaml(click('{ by: text, text: "{{secrets.pw}}" }'))).toThrow(
      /only allowed/,
    )
    expect(() => parseScenarioYaml(click('{ intent: "{{secrets.pw}}" }'))).toThrow(/only allowed/)
    const caption = {
      id: "c",
      source: "manual",
      text: "{{secrets.pw}}",
      at: { ms: 0 },
      until: { ms: 10 },
    }
    expect(Composition.safeParse({ version: 1, tracks: { captions: [caption] } }).success).toBe(
      false,
    )
  })
})

describe("round 3: scroll until has a target", () => {
  it("accepts camera: target on scroll until", () => {
    const yaml = `version: 1\nsteps:\n  - { id: a, action: scroll, until: { intent: footer }, camera: target }\n`
    expect(parseScenarioYaml(yaml).steps).toHaveLength(1)
  })
})
