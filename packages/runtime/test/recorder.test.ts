import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CursorSample,
  parseProjectYaml,
  parseScenarioYaml,
  TakeEvent,
  TakeMeta,
} from "@kiframe/schema"
import { chromium, type Browser } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { recordScenario } from "../src/index.ts"
import { startFixtureServer } from "./fixture-server.ts"

let server: Awaited<ReturnType<typeof startFixtureServer>>
let browser: Browser

beforeAll(async () => {
  server = await startFixtureServer()
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
  await server.close()
})

const SECRET = "hunter2-very-secret"

describe("recordScenario", { timeout: 60_000 }, () => {
  it("writes a complete, schema-valid take with one clock and no secret in any file", async () => {
    const project = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 1280, height: 800 } }
defaults: { pacing: { settleMs: 0, cursor: fast, typing: fast } }
`)
    const scenario = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: /projects }]
steps:
  - { id: open-new, action: click, target: { by: role, role: button, name: New project } }
  - { id: name, action: type, target: { by: label, name: Project name }, value: "Q4 Launch" }
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }
  - { id: palette, action: press, keys: Mod+k }
  - { id: create, action: click, target: { by: role, role: button, name: Create } }
  - { id: done, action: waitFor, until: { text: "Project created: Q4 Launch" } }
`)
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    })
    const page = await context.newPage()
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const take = await recordScenario(page, scenario, project, {
      outDir,
      resolveSecret: () => SECRET,
      timeoutMs: 3000,
    })
    await context.close()

    // Files exist and are schema-valid.
    for (const f of ["frames.webm", "events.jsonl", "cursor.jsonl", "meta.json"])
      expect(existsSync(join(outDir, f)), f).toBe(true)
    const events = readFileSync(join(outDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => TakeEvent.parse(JSON.parse(l)))
    const cursor = readFileSync(join(outDir, "cursor.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => CursorSample.parse(JSON.parse(l)))
    const meta = TakeMeta.parse(JSON.parse(readFileSync(join(outDir, "meta.json"), "utf8")))
    expect(meta).toEqual(take.meta)
    expect(readdirSync(join(outDir, "shots")).sort()).toEqual(
      ["create", "done", "name", "open-new", "palette", "pw"].map((s) => `${s}.jpg`),
    )

    // One clock: events are ordered and inside the take's duration; frames cover it.
    const times = events.map((e) => e.t)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    expect(Math.max(...times)).toBeLessThanOrEqual(meta.durationMs)
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration:stream=width,height",
          "-of",
          "json",
          join(outDir, "frames.webm"),
        ],
        { encoding: "utf8" },
      ),
    ) as { format: { duration: string }; streams: { width: number; height: number }[] }
    // Video time = take time (the first frame is shown from t = 0).
    expect(Math.abs(Number(probe.format.duration) * 1000 - meta.durationMs)).toBeLessThan(100)
    expect(probe.streams[0]).toMatchObject(meta.frameSize)

    // The take has what the generators need.
    const kinds = new Set(events.map((e) => e.kind))
    for (const k of [
      "step_start",
      "step_end",
      "navigate",
      "click",
      "type_start",
      "type_end",
      "key",
      "sensitive",
    ]) {
      expect(kinds.has(k as TakeEvent["kind"]), k).toBe(true)
    }
    const click = events.find((e) => e.kind === "click" && e.stepId === "open-new")
    expect(click?.kind === "click" && click.point.x > 0 && click.point.x < 1).toBe(true)
    expect(cursor.length).toBeGreaterThan(10)
    expect(cursor.some((c) => c.pressed)).toBe(true)
    const sensitive = events.find((e) => e.kind === "sensitive")
    expect(sensitive?.kind === "sensitive" && sensitive.stepId).toBe("pw")

    // The secret value never reaches the take (the name does).
    for (const f of ["events.jsonl", "cursor.jsonl", "meta.json"]) {
      expect(readFileSync(join(outDir, f), "utf8")).not.toContain(SECRET)
    }
    expect(readFileSync(join(outDir, "events.jsonl"), "utf8")).toContain("acme.password")
  })

  const project = () =>
    parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 1280, height: 800 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
  const record = async (
    yaml: string,
    extra: Partial<Parameters<typeof recordScenario>[3]> = {},
  ) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    try {
      return {
        outDir,
        take: await recordScenario(page, parseScenarioYaml(`version: 1\n${yaml}`), project(), {
          outDir,
          timeoutMs: 3000,
          ...extra,
        }),
        page,
      }
    } finally {
      await context.close()
    }
  }

  it("scrubs secrets out of navigation URLs (a login submitted by GET)", async () => {
    const { outDir } = await record(
      `setup: [{ action: goto, url: /get-login }]
steps:
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}", submit: true }
  - { id: after, action: waitFor, until: { url: /get-login } }
`,
      { resolveSecret: () => SECRET },
    )
    const events = readFileSync(join(outDir, "events.jsonl"), "utf8")
    expect(events).not.toContain(SECRET)
    expect(events).not.toContain(encodeURIComponent(SECRET))
    expect(events).toContain("[secret]")
  })

  it("logs the real button of a click", async () => {
    const { take } = await record(`setup: [{ action: goto, url: /get-login }]
steps:
  - { id: menu, action: click, button: right, target: { by: role, role: button, name: Options } }
`)
    const click = take.events.find((e) => e.kind === "click")
    expect(click?.kind === "click" && click.button).toBe("right")
  })

  it("throws the runner's error, and still writes the take", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    await expect(
      recordScenario(
        page,
        parseScenarioYaml(
          `version: 1\nsetup: [{ action: goto, url: /projects }]\nsteps:\n  - { id: boom, action: click, target: { by: role, role: button, name: Missing } }\n`,
        ),
        project(),
        { outDir, timeoutMs: 500 },
      ),
    ).rejects.toThrow(/boom/)
    await context.close()
    expect(existsSync(join(outDir, "meta.json"))).toBe(true)
    expect(existsSync(join(outDir, "frames"))).toBe(false)
  })
})
