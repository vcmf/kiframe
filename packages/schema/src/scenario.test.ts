import { describe, expect, it } from "vitest"
import {
  canonicalTarget,
  Composition,
  GroundedTarget,
  isGrounded,
  NRect,
  parseScenarioYaml,
  RectTuple,
  SchemaError,
  secretRefName,
  TakeEvent,
} from "./index.ts"

const minimal = (steps: string) => `version: 1\nsteps:\n${steps}`

describe("Scenario", () => {
  it("accepts ungrounded targets (draft scenes)", () => {
    const s = parseScenarioYaml(
      minimal(
        `  - id: open\n    action: click\n    target: { intent: "the New project button" }\n`,
      ),
    )
    const step = s.steps[0]
    expect(step?.action === "click" && isGrounded(step.target)).toBe(false)
  })

  it("takes a target in a row (a look-alike), never with a position on top", () => {
    const row = "{ by: role, role: button, name: Delete, in: { role: listitem, has: Pay rent } }"
    const s = parseScenarioYaml(minimal(`  - { id: del, action: click, target: ${row} }\n`))
    const step = s.steps[0]
    expect(step?.action === "click" && step.target).toMatchObject({
      in: { role: "listitem", has: "Pay rent" },
    })
    const withNth = row.replace(/ }$/, ", nth: 1 }")
    expect(() =>
      parseScenarioYaml(minimal(`  - { id: del, action: click, target: ${withNth} }\n`)),
    ).toThrow(/takes no `nth`/)
    // Nor a fallback looked for outside the row (a missing row would let it act in another one).
    const withFallback = row.replace(
      / }$/,
      ", fallbacks: [{ by: role, role: button, name: Delete }] }",
    )
    expect(() =>
      parseScenarioYaml(minimal(`  - { id: del, action: click, target: ${withFallback} }\n`)),
    ).toThrow(/no `fallbacks`/)
    // A blank row text says no row.
    expect(() =>
      parseScenarioYaml(
        minimal(`  - { id: del, action: click, target: ${row.replace("Pay rent", '" "')} }\n`),
      ),
    ).toThrow(/not blank/)
    // The row is part of what a secret approval binds.
    const base = { by: "role", role: "textbox", name: "Key" } as const
    expect(canonicalTarget(GroundedTarget.parse(base))).not.toBe(
      canonicalTarget(GroundedTarget.parse({ ...base, in: { role: "row", has: "Prod" } })),
    )
  })

  it("rejects duplicate step ids", () => {
    const yaml = minimal(
      `  - { id: a, action: pause, ms: 100 }\n  - { id: a, action: pause, ms: 100 }\n`,
    )
    expect(() => parseScenarioYaml(yaml)).toThrow(/duplicate id "a"/)
  })

  it("rejects non-kebab-case step ids", () => {
    expect(() =>
      parseScenarioYaml(minimal(`  - { id: Open_New, action: pause, ms: 1 }\n`)),
    ).toThrow(SchemaError)
  })

  it("requires exactly one scroll mode", () => {
    expect(() => parseScenarioYaml(minimal(`  - { id: s, action: scroll }\n`))).toThrow(
      /exactly one of/,
    )
    expect(() =>
      parseScenarioYaml(
        minimal(`  - { id: s, action: scroll, by: { y: 200 }, to: { intent: "footer" } }\n`),
      ),
    ).toThrow(/exactly one of/)
    expect(
      parseScenarioYaml(minimal(`  - { id: s, action: scroll, by: { y: 200 } }\n`)).steps,
    ).toHaveLength(1)
  })

  it("rejects conditions with more than one form", () => {
    const yaml = minimal(`  - { id: w, action: waitFor, until: { text: "Saved", url: "/done" } }\n`)
    expect(() => parseScenarioYaml(yaml)).toThrow(SchemaError)
  })

  it("checks that camera.until points to a known step", () => {
    const yaml = minimal(
      `  - { id: a, action: pause, ms: 10, camera: { follow: cursor, until: nope } }\n`,
    )
    expect(() => parseScenarioYaml(yaml)).toThrow(/later step, got "nope"/)
  })

  it("rejects presentation fields on off-camera actions", () => {
    const yaml = `version: 1\nsetup:\n  - { action: pause, ms: 10, caption: "hi" }\nsteps:\n  - { id: a, action: pause, ms: 1 }\n`
    expect(() => parseScenarioYaml(yaml)).toThrow(SchemaError)
  })

  it("rejects unknown keys (typos) instead of dropping them", () => {
    expect(() =>
      parseScenarioYaml(minimal(`  - { id: a, action: pause, ms: 1, captoin: "x" }\n`)),
    ).toThrow(/captoin/)
  })
})

describe("normalized geometry", () => {
  it("rejects rects outside the viewport", () => {
    expect(NRect.safeParse({ x: 0.8, y: 0, w: 0.3, h: 0.1 }).success).toBe(false)
    expect(RectTuple.safeParse([0.55, 0.1, 0.4, 0.35]).success).toBe(true)
    expect(RectTuple.safeParse([0.7, 0.1, 0.4, 0.35]).success).toBe(false)
  })
})

describe("secret references", () => {
  it("extracts the secret name only from an exact reference", () => {
    expect(secretRefName("{{secrets.acme_staging.password}}")).toBe("acme_staging.password")
    expect(secretRefName("prefix {{secrets.x}}")).toBeUndefined()
    expect(secretRefName("plain text")).toBeUndefined()
  })
})

describe("Take and Composition", () => {
  it("parses a click event", () => {
    const e = TakeEvent.parse({
      t: 1200,
      phase: "steps",
      stepId: "open-new",
      kind: "click",
      point: { x: 0.5, y: 0.2 },
      rect: { x: 0.45, y: 0.18, w: 0.1, h: 0.04 },
      button: "left",
    })
    expect(e.kind).toBe("click")
  })

  it("defaults every track to empty and parses clip modes", () => {
    const c = Composition.parse({
      version: 1,
      tracks: {
        clips: [
          {
            id: "c1",
            source: "auto",
            mode: "cut",
            at: { ms: 0 },
            until: { step: "open-new", edge: "start" },
          },
          { id: "c2", source: "auto", mode: "freeze", ms: 800, at: { step: "done", edge: "end" } },
        ],
      },
    })
    expect(c.tracks.camera).toEqual([])
    expect(c.tracks.clips[1]?.mode).toBe("freeze")
  })

  it("rejects a speed clip without a positive speed", () => {
    const bad = {
      version: 1,
      tracks: {
        clips: [
          { id: "c", source: "auto", mode: "speed", speed: 0, at: { ms: 0 }, until: { ms: 10 } },
        ],
      },
    }
    expect(Composition.safeParse(bad).success).toBe(false)
  })
})
