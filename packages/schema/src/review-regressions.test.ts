import { describe, expect, it } from "vitest"
import {
  Action,
  checkScenarioAgainstProject,
  Composition,
  CursorSample,
  NRect,
  ProjectConfig,
  parseProjectYaml,
  parseScenarioYaml,
  RectTuple,
  Scenario,
  SchemaError,
  Step,
  TakeEvent,
  TakeMeta,
} from "./index.ts"
import { migrate } from "./versioning.ts"

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
      version: 2,
      // Typed since M1-1 (a StyleOverride).
      style: { background: ["#000000", "#111111"] },
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
    expect(c.style).toEqual({ background: ["#000000", "#111111"] })
    expect(c.tracks.callouts).toHaveLength(1)
    expect(c.tracks.keystrokes).toHaveLength(1)
    expect(Composition.safeParse({ version: 2, tracks: {}, extra: 1 }).success).toBe(false)
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
      version: 2,
      takeKey: "k",
      scenarioHash: "h",
      recordedAt: "2026-09-26T20:00:00+02:00",
      appUrl: "https://x.test",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      frameSize: { width: 2880, height: 1800 },
      fps: 30,
      durationMs: 1000,
      kiframeVersion: "0.0.0",
      outcome: { status: "complete" },
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
  it("rejects prototype keys as preset references", () => {
    expect(() =>
      parseScenarioYaml(`version: 1\nsetup:\n  - preset: constructor\n${steps}`),
    ).toThrow(/reserved name/)
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
        version: 2,
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
  it.each(["{{secret.x}}", "{{Secrets.x}}", "{{ secrets . x }}", "{{secrets..}}"])(
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
        version: 2,
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
      until: 10,
    }
    const boxes = (rect: object) => [{ from: 0, until: 10, rect }]
    expect(
      TakeEvent.safeParse({ ...e, boxes: boxes({ x: 0.2, y: -0.05, w: 0.3, h: 0.1 }) }).success,
    ).toBe(true)
    expect(
      TakeEvent.safeParse({ ...e, boxes: boxes({ x: 0.2, y: 0.3, w: 0.3, h: 0 }) }).success,
    ).toBe(true)
    // A box outside its region's span, or a region without boxes, is refused.
    expect(
      TakeEvent.safeParse({
        ...e,
        boxes: [{ from: 0, until: 11, rect: { x: 0, y: 0, w: 1, h: 1 } }],
      }).success,
    ).toBe(false)
    expect(TakeEvent.safeParse({ ...e, boxes: [] }).success).toBe(false)
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
    ).toThrow(/relative to the environment/)
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
    expect(Composition.safeParse({ version: 2, tracks: { captions: [caption] } }).success).toBe(
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

// ─── Round 4 ─────────────────────────────────────────────────────────────────

describe("round 4: goto URLs", () => {
  const goto = (url: string) =>
    `version: 1\nsteps:\n  - { id: g, action: goto, url: ${JSON.stringify(url)} }\n`

  it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi"])(
    "rejects %s",
    (url) => {
      expect(() => parseScenarioYaml(goto(url))).toThrow(/relative to the environment/)
    },
  )

  it("rejects credentials in protocol-relative URLs", () => {
    expect(() => parseScenarioYaml(goto("//user:pass@staging.acme.com/app"))).toThrow(
      /relative to the environment/,
    )
  })

  it("accepts relative URLs only", () => {
    expect(() => parseScenarioYaml(goto("https://staging.acme.com/x"))).toThrow(
      /relative to the environment/,
    )
    for (const url of ["/projects", "projects?tab=1", "?tab=2"]) {
      expect(parseScenarioYaml(goto(url)).steps).toHaveLength(1)
    }
  })
})

describe("round 4: camera defaults can't frame 'the target'", () => {
  it("rejects target in project defaults and scene overrides", () => {
    expect(() => parseProjectYaml(project("defaults: { camera: target }\n"))).toThrow(SchemaError)
    expect(() =>
      parseScenarioYaml(`version: 1\noverrides: { camera: { frame: target } }\n${steps}`),
    ).toThrow(SchemaError)
  })
})

describe("round 4: ids across presets", () => {
  it("reports two used presets sharing a step id", () => {
    const p = parseProjectYaml(
      project(
        "presets:\n  login-a:\n    steps: [{ id: open-login, action: goto, url: /a }]\n  login-b:\n    steps: [{ id: open-login, action: goto, url: /b }]\n",
      ),
    )
    const s = parseScenarioYaml(
      `version: 1\nsetup:\n  - preset: login-a\n  - preset: login-b\n${steps}`,
    )
    expect(checkScenarioAgainstProject(s, p)).toEqual([
      'preset "login-b" step id "open-login" collides with preset "login-a"',
    ])
  })

  it("says where the first duplicate is", () => {
    expect(() =>
      parseProjectYaml(
        project(
          "presets:\n  p:\n    steps:\n      - { id: x, action: goto, url: /x }\n      - { id: x, action: goto, url: /y }\n",
        ),
      ),
    ).toThrow(/already used in presets\.p\.steps\.0\)/)
  })
})

describe("round 4: spans that can be ordered without a take", () => {
  const caption = (at: object, until: object) => ({
    version: 2,
    tracks: { captions: [{ id: "c", source: "manual", text: "Hi", at, until }] },
  })

  it("rejects inverted or empty scene and same-step spans", () => {
    expect(Composition.safeParse(caption({ scene: "end" }, { scene: "start" })).success).toBe(false)
    expect(
      Composition.safeParse(caption({ step: "x", edge: "end" }, { step: "x", edge: "start" }))
        .success,
    ).toBe(false)
    expect(
      Composition.safeParse(caption({ step: "x", edge: "start" }, { step: "x", edge: "start" }))
        .success,
    ).toBe(false)
  })

  it("accepts spans it can't order without a take", () => {
    expect(
      Composition.safeParse(caption({ step: "a", edge: "end" }, { step: "b", edge: "start" }))
        .success,
    ).toBe(true)
  })
})

describe("round 4: YAML alias keys", () => {
  it("rejects an alias key that resolves to __proto__", () => {
    expect(() => parseScenarioYaml("x: &k __proto__\n*k : { a: 1 }\n")).toThrow(SchemaError)
  })
})

describe("round 4: secret references in the remaining author strings", () => {
  it("rejects them in hide, redaction selectors and keystrokes", () => {
    expect(() => parseProjectYaml(project('hide: ["{{secrets.x}}"]\n'))).toThrow(/only allowed/)
    expect(() =>
      parseProjectYaml(project('redaction: { selectors: ["{{secrets.x}}"] }\n')),
    ).toThrow(/only allowed/)
    const ks = { id: "k", source: "auto", keys: "{{secrets.x}}", at: { ms: 0 }, until: { ms: 10 } }
    expect(Composition.safeParse({ version: 2, tracks: { keystrokes: [ks] } }).success).toBe(false)
  })

  it("validates interrupt rule names in take events", () => {
    expect(
      TakeEvent.safeParse({
        t: 0,
        phase: "steps",
        kind: "interrupt",
        rule: "Cookie Banner",
        until: 1,
      }).success,
    ).toBe(false)
  })
})

// ─── Round 5 ─────────────────────────────────────────────────────────────────

describe("round 5: anchors with offsets on different edges need a take", () => {
  const caption = (at: object, until: object) => ({
    version: 2,
    tracks: { captions: [{ id: "c", source: "manual", text: "Hi", at, until }] },
  })

  it("accepts spans whose order depends on the step duration", () => {
    expect(
      Composition.safeParse(
        caption({ step: "s", edge: "end" }, { step: "s", edge: "start", offsetMs: 5000 }),
      ).success,
    ).toBe(true)
    expect(
      Composition.safeParse(
        caption({ scene: "end", offsetMs: -2000 }, { scene: "start", offsetMs: 5000 }),
      ).success,
    ).toBe(true)
  })

  it("compares absolute times with the scene start", () => {
    expect(Composition.safeParse(caption({ ms: 5000 }, { scene: "start" })).success).toBe(false)
    expect(Composition.safeParse(caption({ scene: "start" }, { ms: 5000 })).success).toBe(true)
  })
})

describe("round 5: ids from repeated presets and interrupt actions", () => {
  it("reports a preset with step ids used twice", () => {
    const p = parseProjectYaml(
      project("presets:\n  login:\n    steps: [{ id: login-go, action: goto, url: /login }]\n"),
    )
    const s = parseScenarioYaml(
      `version: 1\nsetup:\n  - preset: login\n  - preset: login\n${steps}`,
    )
    expect(checkScenarioAgainstProject(s, p)).toEqual([
      'preset "login" is used twice and has step ids',
    ])
  })

  it("rejects ids on interrupt actions", () => {
    expect(() =>
      parseProjectYaml(
        project(
          "interrupts:\n  - id: r\n    when: { text: Hi }\n    do: { id: s1, action: press, keys: Escape }\n",
        ),
      ),
    ).toThrow(/can't have an id/)
  })
})

describe("round 5: secrets", () => {
  it("rejects keystrokes: show on a step typing a secret", () => {
    const yaml = `version: 1\nsteps:\n  - id: pw\n    action: type\n    target: { intent: "password" }\n    value: "{{secrets.acme.password}}"\n    keystrokes: show\n`
    expect(() => parseScenarioYaml(yaml)).toThrow(/can't show keystrokes/)
  })

  it("only accepts secret names (not values) in take events", () => {
    const e = {
      t: 0,
      phase: "steps",
      stepId: "pw",
      kind: "type_start",
      rect: { x: 0, y: 0, w: 0.1, h: 0.1 },
    }
    expect(TakeEvent.safeParse({ ...e, secret: "acme_staging.password" }).success).toBe(true)
    expect(TakeEvent.safeParse({ ...e, secret: "hunter2 !" }).success).toBe(false)
  })

  it("rejects reserved names even outside the YAML loader", () => {
    const config = parseProjectYaml(project())
    expect(() =>
      ProjectConfig.parse({
        ...config,
        presets: { constructor: { steps: [{ action: "goto", url: "/x" }] } },
      }),
    ).toThrow()
  })
})

// ─── Round 6 ─────────────────────────────────────────────────────────────────

describe("round 6: whole-document guards", () => {
  it("rejects __proto__ keys coming from JSON (project.json), not only YAML", () => {
    const config = JSON.parse(
      `{"version":1,"target":{"kind":"web","url":"https://x.test","viewport":{"width":1440,"height":900}},"presets":{"__proto__":{"steps":[{"action":"goto","url":"/x"}]}}}`,
    ) as unknown
    expect(ProjectConfig.safeParse(config).success).toBe(false)
    const comp = JSON.parse(`{"version":1,"tracks":{},"style":{"__proto__":{"a":1}}}`) as unknown
    expect(Composition.safeParse(comp).success).toBe(false)
  })

  it("rejects secret references in any string, including free-form style", () => {
    expect(
      Composition.safeParse({ version: 2, tracks: {}, style: { watermark: "{{secrets.x}}" } })
        .success,
    ).toBe(false)
  })

  it("rejects credentials in take URLs", () => {
    const nav = {
      t: 0,
      phase: "steps",
      stepId: "a",
      kind: "navigate",
      url: "https://u:p@x.com/?t=1",
    }
    expect(TakeEvent.safeParse(nav).success).toBe(false)
  })
})

describe("round 6: span ordering", () => {
  const caption = (at: object, until: object) => ({
    version: 2,
    tracks: { captions: [{ id: "c", source: "manual", text: "Hi", at, until }] },
  })

  it("rejects spans that are inverted whatever the step duration", () => {
    expect(
      Composition.safeParse(
        caption({ step: "a", edge: "end" }, { step: "a", edge: "start", offsetMs: -100 }),
      ).success,
    ).toBe(false)
  })

  it("keeps scene anchors inside the scene", () => {
    expect(
      Composition.safeParse(caption({ scene: "start", offsetMs: -500 }, { ms: 100 })).success,
    ).toBe(false)
    expect(Composition.safeParse(caption({ ms: 0 }, { scene: "end", offsetMs: 500 })).success).toBe(
      false,
    )
  })
})

describe("round 6: CSS selectors can't inject rules", () => {
  it("rejects braces, semicolons and at-rules", () => {
    for (const sel of ["x{} body{background:url(https://evil/?)} y", "a; b", "@import url(x)"]) {
      expect(() => parseProjectYaml(project(`hide: [${JSON.stringify(sel)}]\n`))).toThrow(
        /single CSS selector/,
      )
    }
    expect(
      parseProjectYaml(project('hide: ["#intercom-container", ".nps > .x"]\n')).hide,
    ).toHaveLength(2)
  })
})

describe("round 6: take metadata consistency", () => {
  it("requires frameSize = viewport × DPR", () => {
    const meta = {
      version: 2,
      takeKey: "k",
      scenarioHash: "h",
      recordedAt: "2026-09-26T20:00:00Z",
      appUrl: "https://x.test",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      frameSize: { width: 1440, height: 900 },
      fps: 30,
      durationMs: 1000,
      kiframeVersion: "0.0.0",
      outcome: { status: "complete" },
    }
    expect(TakeMeta.safeParse(meta).success).toBe(false)
    expect(TakeMeta.safeParse({ ...meta, frameSize: { width: 2880, height: 1800 } }).success).toBe(
      true,
    )
  })
})

describe("round 6: scroll within has a target", () => {
  it("accepts emphasis on a scroll inside a container", () => {
    const yaml = `version: 1\nsteps:\n  - { id: a, action: scroll, by: { y: 400 }, within: { by: css, selector: .list }, emphasis: highlight }\n`
    expect(parseScenarioYaml(yaml).steps).toHaveLength(1)
  })
})

// ─── Round 7 ─────────────────────────────────────────────────────────────────

describe("round 7: guards report every problem at once", () => {
  it("returns guard issues and schema issues together", () => {
    const yaml = `version: 1\nsteps:\n  - { id: a, action: pause, ms: 1, caption: "{{secrets.a}}", bogus: 1 }\n`
    const error = (() => {
      try {
        parseScenarioYaml(yaml)
      } catch (e) {
        return e as SchemaError
      }
      throw new Error("expected a SchemaError")
    })()
    expect(error.issues.map((i) => i.message).join("\n")).toMatch(
      /only allowed[\s\S]*bogus|bogus[\s\S]*only allowed/,
    )
  })
})

describe("round 7: secret slots are positional", () => {
  it("rejects type-shaped objects and secret keys in free-form style", () => {
    expect(
      Composition.safeParse({
        version: 2,
        tracks: {},
        style: { x: { action: "type", value: "{{secrets.a}}" } },
      }).success,
    ).toBe(false)
    expect(
      Composition.safeParse({ version: 2, tracks: {}, style: { "{{secrets.a}}": 1 } }).success,
    ).toBe(false)
  })

  it("still allows secrets in preset and interrupt type actions", () => {
    const p = parseProjectYaml(
      project(
        'presets:\n  login:\n    steps: [{ id: email, action: type, target: { by: label, name: Email }, value: "{{secrets.acme.email}}" }]\ninterrupts:\n  - id: otp\n    when: { text: Code }\n    do: { action: type, target: { by: label, name: Code }, value: "{{secrets.acme.otp}}" }\n',
      ),
    )
    expect(p.interrupts).toHaveLength(1)
  })

  it("doesn't flag ordinary template text as a secret", () => {
    const yaml = `version: 1\nsteps:\n  - { id: t, action: type, target: { intent: "body" }, value: "Dear {{ secretary }}, see {{secret_key}}" }\n`
    expect(parseScenarioYaml(yaml).steps).toHaveLength(1)
  })
})

describe("round 7: URLs and timestamps", () => {
  it("rejects credentials in waitFor / expect URL conditions", () => {
    const yaml = `version: 1\nsteps:\n  - { id: w, action: waitFor, until: { url: "https://admin:hunter2@staging.acme.com" } }\n`
    expect(() => parseScenarioYaml(yaml)).toThrow(/credentials/)
  })

  it("accepts fractional take timestamps", () => {
    expect(
      TakeEvent.safeParse({ t: 1.5, phase: "steps", stepId: "a", kind: "settled" }).success,
    ).toBe(true)
  })
})

// ─── Round 8 ─────────────────────────────────────────────────────────────────

describe("round 8: malformed documents", () => {
  it("reports a self-referencing YAML alias instead of overflowing the stack", () => {
    expect(() =>
      parseScenarioYaml("version: 1\nsteps: &s [{action: press, id: a, keys: a, x: *s}]\n"),
    ).toThrow(/cycle/)
  })

  it("reports documents nested too deeply", () => {
    const deep = "x: " + "[".repeat(100) + "]".repeat(100) + "\nversion: 1\n" + steps
    expect(() => parseScenarioYaml(deep)).toThrow(/nested too deeply/)
  })

  it("keeps zod's own issue codes", () => {
    const r = Scenario.safeParse({
      version: 1,
      steps: [{ id: "a", action: "pause", ms: 1, bogus: 1 }],
    })
    expect(r.success).toBe(false)
    expect(r.error?.issues.some((i) => i.code === "unrecognized_keys")).toBe(true)
  })
})

describe("round 8: URLs", () => {
  it("catches credentials hidden behind a scheme without slashes", () => {
    const yaml = `version: 1\nsteps:\n  - { id: w, action: waitFor, until: { url: "http:u:p@evil.com/x" } }\n`
    expect(() => parseScenarioYaml(yaml)).toThrow(/credentials/)
  })

  it("keeps goto inside the target app", () => {
    const yaml = (url: string) =>
      `version: 1\nsteps:\n  - { id: g, action: goto, url: ${JSON.stringify(url)} }\n`
    for (const url of ["//evil.com/login", "\\\\evil.com", "http:evil.com"]) {
      expect(() => parseScenarioYaml(yaml(url))).toThrow(SchemaError)
    }
  })
})

describe("round 8: secret slots are matched from the root", () => {
  it("rejects slot-shaped paths nested inside style", () => {
    const style = {
      steps: [{ action: "type", value: "{{secrets.x}}" }],
      interrupts: [{ do: { action: "type", value: "{{secrets.x}}" } }],
    }
    expect(Composition.safeParse({ version: 2, tracks: {}, style }).success).toBe(false)
  })
})

describe("round 8: CSS selectors can't escape their rule", () => {
  it.each(["#x /*", "*/ body", "</style><script>alert(1)</script>", 'a[title="x]'])(
    "rejects %j",
    (sel) => {
      expect(() => parseProjectYaml(project(`hide: [${JSON.stringify(sel)}]\n`))).toThrow(
        /single CSS selector/,
      )
    },
  )

  it("accepts ordinary selectors with combinators and quoted attributes", () => {
    const p = parseProjectYaml(
      project(`hide: ["ul > li.item", 'a[title="Help"]', "#chat-widget"]\n`),
    )
    expect(p.hide).toHaveLength(3)
  })
})

describe("round 8: duplicate interrupt ids say where", () => {
  it("names the interrupts list", () => {
    const rule = "  - id: r\n    when: { text: Hi }\n    do: { action: press, keys: Escape }\n"
    expect(() => parseProjectYaml(project(`interrupts:\n${rule}${rule}`))).toThrow(
      /already used in interrupts\.0/,
    )
  })
})

// ─── Round 9 ─────────────────────────────────────────────────────────────────

describe("round 9: goto can't leave the app through parser quirks", () => {
  const goto = (url: string) =>
    `version: 1\nsteps:\n  - { id: g, action: goto, url: ${JSON.stringify(url)} }\n`
  it.each([
    " https://evil.com",
    "\thttps://evil.com",
    "h\nttps://evil.com",
    "/\t/evil.com",
    "\\\\evil.com",
  ])("rejects %j", (url) => {
    expect(() => parseScenarioYaml(goto(url))).toThrow(/relative to the environment/)
  })
})

describe("round 9: CSS selectors are self-contained", () => {
  it.each([":is(a", "a[x", "a\\", "a)", "a[x)"])("rejects %j", (sel) => {
    expect(() => parseProjectYaml(project(`hide: [${JSON.stringify(sel)}]\n`))).toThrow(
      /single CSS selector/,
    )
  })

  it("accepts balanced brackets and escapes", () => {
    const p = parseProjectYaml(project(`hide: [":is(.a, .b) > li", "a[data-x='(']", ".x\\\\:y"]\n`))
    expect(p.hide).toHaveLength(3)
  })
})

describe("round 9: secret names", () => {
  it.each(["{{secrets.constructor}}", "{{secrets.acme.__proto__}}"])("rejects %j", (value) => {
    const yaml = `version: 1\nsteps:\n  - id: t\n    action: type\n    target: { intent: "field" }\n    value: ${JSON.stringify(value)}\n`
    expect(() => parseScenarioYaml(yaml)).toThrow(/malformed secret reference/)
  })
})

describe("round 9: issues point at the offending value", () => {
  it("never puts the whole document in an issue's input", () => {
    const doc = {
      version: 1,
      steps: [{ id: "a", action: "pause", ms: 1, caption: "{{secrets.x}}", bogus: 1 }],
    }
    const issues = Scenario.safeParse(doc).error?.issues ?? []
    expect(issues.length).toBeGreaterThanOrEqual(2)
    for (const issue of issues) expect(issue.input).not.toBe(doc)
  })
})

describe("round 9: time zero is before everything", () => {
  it("rejects a span ending at time zero", () => {
    const caption = (until: object) => ({
      version: 2,
      tracks: {
        captions: [
          { id: "c", source: "manual", text: "Hi", at: { step: "a", edge: "end" }, until },
        ],
      },
    })
    expect(Composition.safeParse(caption({ ms: 0 })).success).toBe(false)
    expect(Composition.safeParse(caption({ scene: "start" })).success).toBe(false)
  })
})

describe("on-camera and off-camera actions stay in sync", () => {
  it("Action and Step accept the same action kinds", () => {
    const kinds = (u: { options: readonly { shape: { action: { value: string } } }[] }) =>
      u.options.map((o) => o.shape.action.value).sort()
    expect(kinds(Step)).toEqual(kinds(Action))
    // hover (P0-9) makes 9; select, drag, upload (M1-2) make 12.
    expect(kinds(Step)).toHaveLength(12)
  })
})

// ─── Round 10 ────────────────────────────────────────────────────────────────

describe("round 10", () => {
  it("rejects goto URLs naming a placeholder host", () => {
    for (const url of ["//base.invalid/admin", "//a.invalid/x", "//b.invalid/x"]) {
      const yaml = `version: 1\nsteps:\n  - { id: g, action: goto, url: ${JSON.stringify(url)} }\n`
      expect(() => parseScenarioYaml(yaml)).toThrow(/relative to the environment/)
    }
  })

  it("accepts a fractional take duration", () => {
    const meta = {
      version: 2,
      takeKey: "k",
      scenarioHash: "h",
      recordedAt: "2026-09-26T20:00:00Z",
      appUrl: "https://x.test",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      frameSize: { width: 2880, height: 1800 },
      fps: 30,
      durationMs: 1234.5,
      kiframeVersion: "0.0.0",
      outcome: { status: "complete" },
    }
    expect(TakeMeta.safeParse(meta).success).toBe(true)
  })

  it("rejects CSS strings broken by a newline", () => {
    expect(() =>
      parseProjectYaml(project(`hide: ${JSON.stringify(['a"\n}body{display:none}"'])}\n`)),
    ).toThrow(/single CSS selector/)
  })

  it("rejects collection keys instead of stringifying them", () => {
    expect(() => parseScenarioYaml(`? [a]\n: 1\nversion: 1\n${steps}`)).toThrow(SchemaError)
  })

  it("reports a forbidden key once", () => {
    const r = Scenario.safeParse(
      JSON.parse(`{"version":1,"steps":[{"id":"a","action":"pause","ms":1}],"__proto__":1}`),
    )
    const messages = r.error?.issues.map((i) => i.message) ?? []
    expect(messages).toEqual(['forbidden key "__proto__"'])
  })
})

// ─── Round 11 ────────────────────────────────────────────────────────────────

describe("round 11", () => {
  it("rejects YAML keys that collide once stringified", () => {
    expect(() =>
      parseProjectYaml(
        project(
          'presets:\n  1: { steps: [{ action: pause, ms: 1 }] }\n  "1": { steps: [{ action: pause, ms: 2 }] }\n',
        ),
      ),
    ).toThrow(/DUPLICATE_KEY/)
    expect(() => parseScenarioYaml(`&k a: 1\n*k : 2\nversion: 1\n${steps}`)).toThrow(SchemaError)
  })

  it.each([
    "../../../../Users/x/.ssh/id_rsa",
    "/etc/passwd",
    "C:\\\\x.png",
    "https://x/y.png",
    "fp/../../z.png",
  ])("rejects the fingerprint path %j", (fp) => {
    const yaml = `version: 1\nsteps:\n  - { id: c, action: click, target: { by: text, text: Go, fingerprint: ${JSON.stringify(fp)} } }\n`
    expect(() => parseScenarioYaml(yaml)).toThrow(SchemaError)
  })

  it("accepts a fingerprint inside the scene", () => {
    const yaml = `version: 1\nsteps:\n  - { id: c, action: click, target: { by: text, text: Go, fingerprint: fp/open-new.png } }\n`
    expect(parseScenarioYaml(yaml).steps).toHaveLength(1)
  })

  it("accepts the environment in take metadata", () => {
    const meta = {
      version: 2,
      takeKey: "k",
      scenarioHash: "h",
      recordedAt: "2026-09-26T20:00:00Z",
      appUrl: "https://x.test",
      environment: "staging",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      frameSize: { width: 2880, height: 1800 },
      fps: 30,
      durationMs: 1000,
      kiframeVersion: "0.0.0",
      outcome: { status: "complete" },
    }
    expect(TakeMeta.safeParse(meta).success).toBe(true)
  })

  it("requires text on text callouts", () => {
    const callout = {
      id: "c",
      source: "manual",
      kind: "text",
      at: { ms: 0 },
      until: { ms: 10 },
      target: { rect: { x: 0, y: 0, w: 0.1, h: 0.1 } },
    }
    expect(Composition.safeParse({ version: 2, tracks: { callouts: [callout] } }).success).toBe(
      false,
    )
    expect(
      Composition.safeParse({ version: 2, tracks: { callouts: [{ ...callout, kind: "arrow" }] } })
        .success,
    ).toBe(true)
  })

  it("rejects blank or whitespace goto URLs", () => {
    for (const url of ["  ", " /projects", "/pro jects"]) {
      const yaml = `version: 1\nsteps:\n  - { id: g, action: goto, url: ${JSON.stringify(url)} }\n`
      expect(() => parseScenarioYaml(yaml)).toThrow(SchemaError)
    }
  })
})

// ─── Round 12 ────────────────────────────────────────────────────────────────

describe("round 12", () => {
  it("rejects `<` inside quoted CSS strings too", () => {
    const sel = '[title="</style><img src=x onerror=alert(1)>"]'
    expect(() => parseProjectYaml(project(`hide: [${JSON.stringify(sel)}]\n`))).toThrow(
      /single CSS selector/,
    )
  })

  it("maps null YAML keys like toJS does", () => {
    expect(() => parseScenarioYaml(`~: 1\n"": 2\nversion: 1\n${steps}`)).toThrow(SchemaError)
    expect(() => parseScenarioYaml(`null: 1\n"null": 2\nversion: 1\n${steps}`)).toThrow(SchemaError)
  })

  it("reports a forbidden record key once", () => {
    const config = JSON.parse(
      `{"version":1,"target":{"kind":"web","url":"https://x.test","viewport":{"width":1440,"height":900}},"presets":{"constructor":{"steps":[{"action":"goto","url":"/x"}]}}}`,
    ) as unknown
    const messages = ProjectConfig.safeParse(config).error?.issues.map((i) => i.message) ?? []
    expect(messages).toEqual(['forbidden key "constructor"'])
  })

  it("rejects Maps and Sets that would hide their contents", () => {
    const style = { x: new Set(["{{secrets.pw}}"]) }
    expect(Composition.safeParse({ version: 2, tracks: {}, style }).success).toBe(false)
  })

  it("restricts freeze reasons to reading and user", () => {
    const freeze = {
      id: "f",
      source: "auto",
      mode: "freeze",
      ms: 500,
      at: { ms: 0 },
      reason: "interrupt",
    }
    expect(Composition.safeParse({ version: 2, tracks: { clips: [freeze] } }).success).toBe(false)
  })

  it("gives a plain 'required' error for a missing DPR in take metadata", () => {
    const meta = {
      version: 2,
      takeKey: "k",
      scenarioHash: "h",
      recordedAt: "2026-09-26T20:00:00Z",
      appUrl: "https://x.test",
      viewport: { width: 1440, height: 900 },
      frameSize: { width: 2880, height: 1800 },
      fps: 30,
      durationMs: 1000,
      kiframeVersion: "0.0.0",
      outcome: { status: "complete" },
    }
    const messages =
      TakeMeta.safeParse(meta)
        .error?.issues.map((i) => i.message)
        .join(" ") ?? ""
    expect(messages).not.toMatch(/nonoptional/)
  })
})

// ─── Round 13 (non-severe hardening, applied without a new round) ────────────

describe("round 13", () => {
  it("rejects escaped `<` in CSS selectors", () => {
    const sel = "x\\</style\\><img src=x onerror=alert(1)>"
    expect(() => parseProjectYaml(project(`hide: [${JSON.stringify(sel)}]\n`))).toThrow(
      /single CSS selector/,
    )
  })

  it("keeps YAML keys as written (no NaN / Infinity collisions or false duplicates)", () => {
    expect(() => parseScenarioYaml(`.inf: 1\n-.inf: 2\nversion: 1\n${steps}`)).toThrow(
      /Unrecognized key/,
    )
    expect(() => parseScenarioYaml(`1: a\n"1": b\nversion: 1\n${steps}`)).toThrow(/DUPLICATE_KEY/)
  })

  it("rejects YAML 1.1 documents", () => {
    expect(() => parseScenarioYaml(`%YAML 1.1\n---\nversion: 1\n${steps}`)).toThrow(/YAML 1.2/)
  })

  it("rejects spans starting at the scene end", () => {
    const clip = {
      id: "c",
      source: "auto",
      mode: "cut",
      at: { scene: "end" },
      until: { scene: "start", offsetMs: 5 },
    }
    expect(Composition.safeParse({ version: 2, tracks: { clips: [clip] } }).success).toBe(false)
  })

  it("doesn't echo the source line in YAML errors", () => {
    expect(() =>
      parseScenarioYaml("version: 1\nsteps: [ { id: a, action: type, value: hunter2: x } ]\n"),
    ).toThrow(/^(?![\s\S]*hunter2)/)
  })

  it("guards cursor samples like other take records", () => {
    expect(
      CursorSample.safeParse({ t: 0, p: { x: 0.1, y: 0.1 }, pressed: false, css: "{{secrets.x}}" })
        .success,
    ).toBe(false)
  })
})

describe("secret regions left the composition (SECRETS-DESIGN I4, T7)", () => {
  const rect = { x: 0, y: 0, w: 0.1, h: 0.1 }
  const mask = (id: string, target: object, extra: object = {}) => ({
    id,
    source: "auto",
    kind: "blur",
    at: { ms: 0 },
    until: { ms: 10 },
    target,
    ...extra,
  })
  const region = { sensitiveId: "secret:x" }

  it("drops auto masks and highlights on secret regions, keeps a user's blur of one", () => {
    const { doc } = migrate("composition", {
      version: 1,
      tracks: {
        masks: [
          mask("auto", region),
          mask("mine", region, { source: "manual" }),
          mask("spot", region, { source: "manual", kind: "spotlight" }),
          mask("r", { rect }),
        ],
      },
    })
    const c = Composition.parse(doc)
    expect(c.version).toBe(2)
    expect(c.tracks.masks.map((m) => m.id)).toEqual(["mine", "r"])
  })

  it("moves an anchor to a region to the start of its step", () => {
    const caption = {
      id: "c",
      source: "manual",
      text: "Hi",
      at: { event: "login:sensitive:1", offsetMs: 100 },
      until: { step: "login", edge: "end" },
    }
    const { doc } = migrate("composition", { version: 1, tracks: { captions: [caption] } })
    expect(Composition.parse(doc).tracks.captions[0]?.at).toEqual({
      step: "login",
      edge: "start",
      offsetMs: 100,
    })
    // Another segment never ends before it starts: its end goes to the step's end unless both
    // ends were that step's regions (then its length is kept).
    const late = { ...caption, id: "d", at: { step: "login", edge: "start", offsetMs: 500 } }
    const both = { ...caption, id: "e", until: { event: "login:sensitive:2", offsetMs: 900 } }
    const moved = migrate("composition", {
      version: 1,
      tracks: { captions: [{ ...late, until: { event: "login:sensitive:1" } }, both] },
    })
    const [d, e] = Composition.parse(moved.doc).tracks.captions
    expect(d?.until).toEqual({ step: "login", edge: "end" })
    expect(e?.until).toEqual({ step: "login", edge: "start", offsetMs: 900 })
    // An end anchor goes to the step's end: a mask never gets shorter (nor inverted).
    const mine = {
      id: "m",
      source: "manual",
      kind: "blur",
      at: { step: "login", edge: "start", offsetMs: 500 },
      until: { event: "login:sensitive:1" },
      target: { rect: { x: 0, y: 0, w: 0.1, h: 0.1 } },
    }
    const masked = migrate("composition", { version: 1, tracks: { masks: [mine] } })
    expect(Composition.parse(masked.doc).tracks.masks[0]?.until).toEqual({
      step: "login",
      edge: "end",
    })
  })

  it("only lets a blur or pixelate name a secret region", () => {
    const v2 = (m: object) => Composition.safeParse({ version: 2, tracks: { masks: [m] } }).success
    expect(v2(mask("b", region, { source: "manual" }))).toBe(true)
    expect(v2(mask("s", region, { source: "manual", kind: "spotlight" }))).toBe(false)
  })
})
