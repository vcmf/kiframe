import { execFileSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
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
import { pathOnly, recordScenario, scrubSecrets } from "../src/index.ts"
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
    // Query strings aren't recorded at all: only origin + path.
    expect(events).not.toContain("?")
    expect(events).toContain("/get-login")
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
    // A failed take is kept next to where the take would be, never in its place.
    expect(existsSync(join(`${outDir}.failed`, "meta.json"))).toBe(true)
    expect(existsSync(join(`${outDir}.failed`, "frames"))).toBe(false)
  })

  it("scrubs WHATWG-encoded secrets from GET form URLs", async () => {
    const tricky = "Pa55!(x)~y'z"
    const { outDir } = await record(
      `setup: [{ action: goto, url: /get-login }]
steps:
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}", submit: true }
  - { id: after, action: waitFor, until: { url: /get-login } }
`,
      { resolveSecret: () => tricky },
    )
    const events = readFileSync(join(outDir, "events.jsonl"), "utf8")
    expect(events).not.toContain(new URLSearchParams({ v: tricky }).toString().slice(2))
    expect(events).not.toContain(tricky)
  })

  it("refuses to overwrite a folder that isn't a take", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-not-a-take-"))
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "package.json"), "{}")
    const context = await browser.newContext()
    const page = await context.newPage()
    await expect(
      recordScenario(
        page,
        parseScenarioYaml("version: 1\nsteps: [{ id: a, action: pause, ms: 1 }]\n"),
        project(),
        { outDir: dir },
      ),
    ).rejects.toThrow(/refusing to overwrite/)
    await context.close()
    expect(existsSync(join(dir, "package.json"))).toBe(true)
  })
})

describe("scrubSecrets", () => {
  it("catches percent-encodings in any case and base64url", () => {
    const secret = "a/b+c?d"
    const b64url = Buffer.from(secret)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    const text = `?p=${encodeURIComponent(secret).toLowerCase()}&t=${b64url}&raw=${secret}`
    const scrubbed = scrubSecrets(text, [secret])
    expect(scrubbed).not.toContain(secret)
    expect(scrubbed.toLowerCase()).not.toContain(encodeURIComponent(secret).toLowerCase())
    expect(scrubbed).not.toContain(b64url)
  })

  it("replaces overlapping secrets whole, and percent-encoded base64", () => {
    const scrubbed = scrubSecrets(
      `?pw=password123&t=${encodeURIComponent(Buffer.from("s3cr3t??>").toString("base64"))}`,
      ["pass", "password123", "s3cr3t??>"],
    )
    expect(scrubbed).toBe("?pw=[secret]&t=[secret]")
  })

  it("catches a secret in a URL path (WHATWG path encoding keeps | as is)", () => {
    const secret = "Pässw|rd x"
    const path = new URL(`http://x/${secret}`).pathname
    expect(scrubSecrets(path, [secret])).toBe("/[secret]")
    // Never a piece of the secret as a pattern (the URL parser would cut "p#Kd93!x" to "p").
    expect(scrubSecrets("https://app.example.com/projects", ["p#Kd93!x", "a?b"])).toBe(
      "https://app.example.com/projects",
    )
    expect(scrubSecrets("/p%23Kd93!x", ["p#Kd93!x"])).toBe("/[secret]")
  })
})

describe("take directories", { timeout: 60_000 }, () => {
  const project = () =>
    parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 1280, height: 800 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
  const scenario = (steps: string) =>
    parseScenarioYaml(`version: 1\nsetup: [{ action: goto, url: /projects }]\nsteps:\n${steps}`)

  it("re-records over an interrupted take, but never over a folder with an unrelated meta.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-take-"))
    const interrupted = join(dir, "interrupted")
    mkdirSync(join(interrupted, "frames"), { recursive: true })
    writeFileSync(join(interrupted, ".kiframe-take"), "kiframe take\n")
    const unrelated = join(dir, "project")
    mkdirSync(unrelated)
    writeFileSync(join(unrelated, "meta.json"), "{}")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const take = await recordScenario(
      page,
      scenario("  - { id: a, action: pause, ms: 50 }\n"),
      project(),
      { outDir: interrupted },
    )
    expect(take.meta.outcome).toEqual({ status: "complete" })
    await expect(
      recordScenario(page, scenario("  - { id: a, action: pause, ms: 50 }\n"), project(), {
        outDir: unrelated,
      }),
    ).rejects.toThrow(/refusing to overwrite/)
    await context.close()
    expect(existsSync(join(unrelated, "meta.json"))).toBe(true)
  })

  it("marks a failed take as failed in its metadata", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await expect(
      recordScenario(
        page,
        scenario(
          "  - { id: boom, action: click, target: { by: role, role: button, name: Missing } }\n",
        ),
        project(),
        {
          outDir,
          timeoutMs: 500,
        },
      ),
    ).rejects.toThrow(/boom/)
    await context.close()
    const meta = TakeMeta.parse(
      JSON.parse(readFileSync(join(`${outDir}.failed`, "meta.json"), "utf8")),
    )
    expect(meta.outcome.status).toBe("failed")
  })

  it("scrubs secret values out of the errors it records", async () => {
    // The typed secret happens to equal a word in a later failing step's error message.
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const error = await recordScenario(
      page,
      scenario(`  - { id: open-new, action: click, target: { by: role, role: button, name: New project } }
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }
  - { id: boom, action: click, target: { by: role, role: button, name: Zebra42 } }
`),
      project(),
      { outDir, timeoutMs: 500, resolveSecret: () => "Zebra42" },
    ).then(
      () => new Error("expected the recording to fail"),
      (e: unknown) => e as Error,
    )
    await context.close()
    expect(error.message).toMatch(/boom/)
    expect(error.message).not.toContain("Zebra42")
    // Playwright's full call log (the cause) is never carried out of the runner once secrets were used.
    expect(error.cause).toBeUndefined()
    expect(readFileSync(join(`${outDir}.failed`, "meta.json"), "utf8")).not.toContain("Zebra42")
  })

  it("writes empty JSONL files when there's nothing to log", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await recordScenario(page, scenario("  - { id: a, action: pause, ms: 50 }\n"), project(), {
      outDir,
    })
    await context.close()
    expect(readFileSync(join(outDir, "cursor.jsonl"), "utf8")).toBe("")
  })

  it("keeps the good take when a re-record fails, whatever the trailing slash", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const good = await recordScenario(
      page,
      scenario("  - { id: a, action: pause, ms: 50 }\n"),
      project(),
      { outDir: `${outDir}/` },
    )
    expect(good.meta.outcome.status).toBe("complete")
    await expect(
      recordScenario(
        page,
        scenario(
          "  - { id: boom, action: click, target: { by: role, role: button, name: Missing } }\n",
        ),
        project(),
        {
          outDir: `${outDir}/`,
          timeoutMs: 400,
        },
      ),
    ).rejects.toThrow(/boom/)
    await context.close()
    const kept = TakeMeta.parse(JSON.parse(readFileSync(join(outDir, "meta.json"), "utf8")))
    expect(kept.takeKey).toBe(good.meta.takeKey)
    expect(existsSync(`${outDir}.failed`)).toBe(true)
    // No temporary folder left behind.
    expect(readdirSync(join(outDir, "..")).filter((n) => n.includes(".recording-"))).toEqual([])
  })
})

describe("scrubbing, one pass", () => {
  it("never nests markers when one secret is part of the marker or of another secret", () => {
    expect(scrubSecrets("pw=hunter2&x=secret", ["hunter2", "secret", "sec"])).toBe(
      "pw=[secret]&x=[secret]",
    )
  })

  it("handles double encodings and lone surrogates", () => {
    const secret = "p@ss w0rd!"
    const twice = encodeURIComponent(new URLSearchParams({ v: secret }).toString().slice(2))
    expect(scrubSecrets(`next=${twice}`, [secret])).toBe("next=[secret]")
    expect(() => scrubSecrets("x", ["bad\ud800"])).not.toThrow()
  })
})

describe("take details", { timeout: 60_000 }, () => {
  const project = () =>
    parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 1280, height: 800 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
  const scenario = (steps: string) =>
    parseScenarioYaml(`version: 1\nsetup: [{ action: goto, url: /projects }]\nsteps:\n${steps}`)

  it("keeps filming when the run follows a new tab (one clock across pages)", async () => {
    // Frames only come on repaint: the opener is static, the new tab is animated. The same
    // scene without following the tab is the baseline.
    const record = async (steps: string) => {
      const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      const page = await context.newPage()
      const take = await recordScenario(
        page,
        parseScenarioYaml(`version: 1\nsetup: [{ action: goto, url: /opener }]\nsteps:\n${steps}`),
        project(),
        { outDir },
      )
      await context.close()
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          [
            "-v",
            "error",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "json",
            join(outDir, "frames.webm"),
          ],
          { encoding: "utf8" },
        ),
      ) as { streams: { nb_read_frames: string }[] }
      return { take, frames: Number(probe.streams[0]?.nb_read_frames) }
    }
    const followed =
      await record(`  - { id: tab, action: click, target: { by: role, role: link, name: Open report } }
  - { id: seen, action: expect, that: { visible: { by: role, role: heading, name: Report } } }
  - { id: look, action: pause, ms: 800 }
`)
    const baseline =
      await record(`  - { id: stay, action: expect, that: { visible: { by: role, role: link, name: Open report } } }
  - { id: look, action: pause, ms: 800 }
`)
    expect(followed.take.meta.outcome.status).toBe("complete")
    expect(
      followed.take.events.some((e) => e.kind === "navigate" && e.url.endsWith("/popup-report")),
    ).toBe(true)
    expect(followed.frames).toBeGreaterThan(baseline.frames + 5)
  })

  it("normalizes rects to a popup's own size, and re-blurs the opener's secret right on return", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const take = await recordScenario(
      page,
      parseScenarioYaml(`version: 1
setup: [{ action: goto, url: /opener }]
steps:
  - { id: key, action: type, target: { by: label, name: API key }, value: "{{secrets.acme.key}}" }
  - { id: open, action: click, target: { by: role, role: button, name: Open popup } }
  - { id: code, action: type, target: { by: label, name: Code }, value: "{{secrets.acme.code}}" }
  - { id: done, action: click, target: { by: role, role: button, name: Done } }
  - { id: look, action: pause, ms: 300 }
`),
      project(),
      { outDir, resolveSecret: (name) => (name === "acme.key" ? "k-123456" : "c-987654") },
    )
    await context.close()
    const sensitive = take.events.filter(
      (e): e is Extract<typeof e, { kind: "sensitive" }> => e.kind === "sensitive",
    )
    // The popup is 800×600: its field at (300..500, 285..315) is centred at (0.5, 0.5).
    const code = sensitive.find((e) => e.id.includes("acme.code") && e.rect.w > 0)
    expect(code?.rect.x).toBeCloseTo(300 / 800, 2)
    expect(code?.rect.y).toBeCloseTo(285 / 600, 2)
    // Back on the opener (in the "done" step), the API key's blur is back before the next step.
    const lookStart =
      take.events.find((e) => e.kind === "step_start" && e.stepId === "look")?.t ?? 0
    const keyEvents = sensitive.filter((e) => e.id.includes("acme.key"))
    const goneAt = keyEvents.find((e) => e.rect.w === 0)?.t ?? Infinity
    const backAt = keyEvents.find((e) => e.t > goneAt && e.rect.w > 0)?.t ?? Infinity
    expect(backAt).toBeLessThanOrEqual(lookStart)
  })

  it("follows a secret field with its blur when the page scrolls", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const take = await recordScenario(
      page,
      scenario(`  - { id: open-new, action: click, target: { by: role, role: button, name: New project } }
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }
  - { id: down, action: scroll, by: { y: 150 } }
`),
      project(),
      { outDir, resolveSecret: () => SECRET },
    )
    await context.close()
    const rects = take.events.flatMap((e) => (e.kind === "sensitive" ? [e.rect.y] : []))
    // Logged at type_start, then again after each step; after the scroll it's higher on screen.
    expect(rects.length).toBeGreaterThanOrEqual(3)
    expect(Math.min(...rects)).toBeLessThan(Math.max(...rects))
  })

  it("ends the blur once when the secret field is gone, and doesn't stall later steps", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const started = Date.now()
    const take = await recordScenario(
      page,
      scenario(`  - { id: open-new, action: click, target: { by: role, role: button, name: New project } }
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }
  - { id: away, action: goto, url: /projects }
  - { id: w1, action: scroll, by: { y: 10 } }
  - { id: w2, action: scroll, by: { y: 10 } }
  - { id: w3, action: scroll, by: { y: 10 } }
`),
      project(),
      { outDir, resolveSecret: () => SECRET },
    )
    await context.close()
    const sensitive = take.events.filter((e) => e.kind === "sensitive")
    const gone = sensitive.filter((e) => e.rect.w === 0 && e.rect.h === 0)
    expect(gone.length).toBe(1)
    expect(sensitive.at(-1)).toBe(gone[0])
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it("keeps a complete take when only the teardown fails", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const take = await recordScenario(
      page,
      parseScenarioYaml(`version: 1
steps: [{ id: open, action: goto, url: /projects }]
teardown: [{ action: click, target: { by: css, selector: "#missing" } }]
`),
      project(),
      { outDir, timeoutMs: 500 },
    )
    await context.close()
    expect(take.meta.outcome.status).toBe("complete")
    expect(take.teardownError?.step.phase).toBe("teardown")
    expect(take.warnings.some((w) => w.startsWith("teardown failed"))).toBe(true)
    expect(existsSync(join(outDir, "meta.json"))).toBe(true)
  })

  it("keeps a storyboard shot for a first step that starts before any frame", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await recordScenario(
      page,
      parseScenarioYaml(`version: 1\nsteps:\n  - { id: first, action: goto, url: /projects }\n`),
      project(),
      { outDir },
    )
    await context.close()
    expect(existsSync(join(outDir, "shots", "first.jpg"))).toBe(true)
  })

  it("records into the real location of a symlinked take folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "kiframe-link-"))
    const real = join(root, "vault-volume", "scene")
    mkdirSync(real, { recursive: true })
    writeFileSync(join(real, ".kiframe-take"), "kiframe take\n")
    const link = join(root, "scene")
    symlinkSync(real, link)
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await recordScenario(page, scenario("  - { id: a, action: pause, ms: 50 }\n"), project(), {
      outDir: link,
    })
    await context.close()
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(join(real, "meta.json"))).toBe(true)
  })

  it("logs the Enter of a submit as a key", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "kiframe-take-")), "take")
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const take = await recordScenario(
      page,
      scenario(`  - { id: open-new, action: click, target: { by: role, role: button, name: New project } }
  - { id: name, action: type, target: { by: label, name: Project name }, value: Q4, submit: true }
`),
      project(),
      { outDir },
    )
    await context.close()
    const kinds = take.events
      .filter((e) => e.stepId === "name")
      .map((e) => (e.kind === "key" ? `key:${e.key}` : e.kind))
    expect(kinds.indexOf("type_end")).toBeLessThan(kinds.indexOf("key:Enter"))
  })
})

describe("pathOnly", () => {
  it("keeps origin + path, and only the scheme of non-web URLs", () => {
    expect(pathOnly("https://app.test/login?pw=x#h")).toBe("https://app.test/login")
    expect(pathOnly("blob:https://app.test/1234-uuid")).toBe("blob:")
    expect(pathOnly("data:text/html;base64,AAAA")).toBe("data:")
  })
})
