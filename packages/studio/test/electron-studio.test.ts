import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, saveScene, TakeStore } from "@kiframe/project"
import { parseProjectYaml } from "@kiframe/schema"
import { chromium, type Browser } from "playwright"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { launchElectronWith } from "../../runtime/src/electron.ts"
import { Studio, studioTools } from "../src/index.ts"

// Kif in a desktop app (PR 4b): the studio grounds, checks and records a scene in the runtime's
// fixture app, launched for real (the host's launcher replaced by the test's: confined on macOS,
// unconfined on Linux CI), and leaves nothing running.

const electron = createRequire(join(import.meta.dirname, "../../../apps/desktop/package.json"))(
  "electron",
) as string
const fixture = join(import.meta.dirname, "../../runtime/test/fixtures/electron-app")
const electronApp = electron.slice(0, electron.indexOf(".app/") + 4)
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 }

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
})

const closing: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closing.splice(0)) await close().catch(() => undefined)
})

/** A studio over a project whose app is the fixture desktop app, launched by the test. */
function studioWith(
  launch?: (app: string, signal: AbortSignal) => Promise<never>,
  appsYaml = "  notes: { kind: electron, bundleId: com.kiframe.fixture, viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }\n",
) {
  const dir = join(mkdtempSync(join(tmpdir(), "kiframe-el-studio-")), "demo.kiframe")
  const project = createProject(dir, { id: "p1", name: "Demo", url: "https://app.test" })
  const work = mkdtempSync(join(tmpdir(), "kiframe-el-studio-work-"))
  const data = mkdtempSync(join(tmpdir(), "kiframe-el-studio-data-"))
  const takes = new TakeStore(data)
  const launches: string[] = []
  const studio = new Studio({
    project,
    scope: "folder-1",
    sceneKey: (id) => `host-${id}`,
    config: parseProjectYaml(`version: 2
apps:
${appsYaml}defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`),
    takes,
    browser,
    requestUser: () => Promise.resolve(false),
    stopRun: () => undefined,
    launchDesktop:
      launch ??
      (async (app, signal) => {
        launches.push(app)
        const target = await launchElectronWith(
          { executable: electron, bundle: fixture, workDir: work, viewport, signal, settleMs: 300 },
          { appArgs: [fixture, "hidden"], readable: [electronApp], allowUnconfined: true },
        )
        closing.push(() => target.close().then(() => undefined))
        return { target, build: { version: "44.4.5", opens: "a".repeat(64) } }
      }),
  })
  closing.push(() => studio.close())
  return { studio, project, data, work, launches }
}

const tool = (name: string) => studioTools.find((t) => t.name === name)!
const run = (studio: Studio, name: string, input: object) =>
  tool(name).run(input, studio, new AbortController().signal)
const sandboxes = (work: string) =>
  existsSync(join(work, "sandboxes"))
    ? readdirSync(join(work, "sandboxes")).filter((n) => !n.endsWith(".canary"))
    : []

describe("Kif in a desktop app", { timeout: 120_000 }, () => {
  it("grounds a scene in its window: its own pages said as such, never a file path", async () => {
    const { studio, launches } = studioWith()
    const seen = (await run(studio, "snapshot", {})) as { result?: string; error?: string }
    const text = JSON.stringify(seen)
    expect(text).toContain("notes's own page")
    // The app's own file path (the user's machine) never reaches the agent (its page's own
    // content, a link to a file, is the page's).
    expect(text).not.toContain(fixture)
    expect(text).not.toContain("index.html")
    const step = (await run(studio, "run_step", {
      scene: "s",
      start_app: "notes",
      step: {
        id: "add",
        action: "click",
        target: { by: "role", role: "button", name: "Add note" },
      },
    })) as object
    expect(JSON.stringify(step)).toContain("notes's own page")
    const checked = (await run(studio, "run_step", {
      scene: "s",
      start_app: "notes",
      step: { id: "one", action: "expect", that: { text: "Notes: 1" } },
    })) as object
    expect(JSON.stringify(checked)).not.toContain("error")
    // One launch for the live session (never one per step).
    expect(launches).toEqual(["notes"])
  })

  it("looks at a ref in its window (its size read from the page)", async () => {
    const { studio } = studioWith()
    const shot = JSON.stringify(await run(studio, "snapshot", {}))
    const ref = /\[ref=(e\d+)\]/.exec(shot)?.[1]
    expect(ref).toBeDefined()
    const looked = JSON.stringify(await run(studio, "look", { ref }))
    expect(looked).not.toContain("error")
  })

  it("says an app that quit while grounded, launched again fresh", async () => {
    const { studio, launches } = studioWith()
    await studio.livePage("notes")
    // The app's only window closed: the fixture quits.
    await studio.currentPage?.close()
    const step = JSON.stringify(
      await run(studio, "run_step", {
        scene: "s",
        start_app: "notes",
        step: { id: "a", action: "pause", ms: 1 },
      }),
    )
    expect(step).toContain("notes quit: launched again fresh")
    expect(launches).toEqual(["notes", "notes"])
  })

  it("checks and records a scene in a fresh launch each, its take keeping the build", async () => {
    const { studio, project, data, work, launches } = studioWith()
    const yaml = `version: 1
app: notes
steps:
  - { id: add, action: click, target: { by: role, role: button, name: Add note } }
  - { id: one, action: expect, that: { text: "Notes: 1" } }
  - { id: two, action: click, target: { by: role, role: button, name: Add note } }
  - { id: three, action: expect, that: { text: "Notes: 2" } }
  - { id: rest, action: pause, ms: 100 }
`
    const checked = studio.check(yaml)
    if ("error" in checked) throw new Error(checked.error)
    expect(await studio.replay(checked.scenario, "s", new AbortController().signal)).toBe("ok")
    saveScene(
      project,
      {
        version: 1,
        id: "s",
        title: "S",
        source: { kind: "recording" },
        duration: { mode: "auto" },
      },
      { scenario: checked.scenario },
    )
    const recorded = await studio.record("s", new AbortController().signal)
    expect(recorded).toMatchObject({ ok: true })
    // A launch each (the check's, the recording's), each closed: no sandbox left.
    expect(launches).toEqual(["notes", "notes"])
    expect(sandboxes(work)).toEqual([])
    // The take's meta, wherever the store keeps it.
    const metas = readdirSync(data, { recursive: true, encoding: "utf8" }).filter((p) =>
      p.endsWith("meta.json"),
    )
    expect(metas).toHaveLength(1)
    const meta = JSON.parse(readFileSync(join(data, metas[0] ?? ""), "utf8")) as {
      appBuild?: unknown
      appUrl: string
    }
    expect(meta.appUrl).toBe("electron:com.kiframe.fixture")
    expect(meta.appBuild).toEqual({ version: "44.4.5", opens: "a".repeat(64) })
  })

  it("says a refusal the user settles for them, and never saves a handover in a desktop scene", async () => {
    const refused = Object.assign(new Error("notes: approved for another project"), {
      needsUser: true,
    })
    const { studio } = studioWith(() => Promise.reject(refused))
    const step = JSON.stringify(
      await run(studio, "run_step", {
        scene: "s",
        start_app: "notes",
        step: { id: "a", action: "pause", ms: 1 },
      }),
    )
    expect(step).toContain("The user settles this (the Apps panel): tell them, don't retry")
    const saved = studio.check(`version: 1
app: notes
setup:
  - { action: handover, task: Sign in, done_when: You see your notes }
steps:
  - { id: a, action: pause, ms: 1 }
  - { id: b, action: pause, ms: 1 }
  - { id: c, action: pause, ms: 1 }
  - { id: d, action: pause, ms: 1 }
  - { id: e, action: pause, ms: 1 }
`)
    expect(saved).toMatchObject({ error: expect.stringMatching(/no handover step/) as string })
  })

  it("closes its desktop app with the studio (nothing left running)", async () => {
    const { studio, work } = studioWith()
    await studio.livePage("notes")
    expect(sandboxes(work)).toHaveLength(1)
    await studio.close()
    expect(sandboxes(work)).toEqual([])
  })

  it("hands nothing over live, closes an app removed from the project, says a relaunch on failure", async () => {
    const { studio, work } = studioWith()
    await studio.livePage("notes")
    expect(await studio.handOver("Sign in", undefined, new AbortController().signal)).toMatchObject(
      {
        error: expect.stringMatching(/isn't handed to the user yet/) as string,
      },
    )
    // The app quit; the next step fails: the relaunch is said all the same.
    await studio.currentPage?.close()
    const failing = JSON.stringify(
      await run(studio, "run_step", {
        scene: "s",
        start_app: "notes",
        step: { id: "nine", action: "expect", that: { text: "Notes: 9" }, timeout: 500 },
      }),
    )
    expect(failing).toContain("notes quit: launched again fresh")
    // Removed from the project (its approval dropped): its live launch closed.
    studio.setApps({})
    await expect.poll(() => sandboxes(work).length, { timeout: 10_000 }).toBe(0)
  })

  it("never resolves a ref on another app's page (a new snapshot asked)", async () => {
    const twice =
      "  notes: { kind: electron, bundleId: com.kiframe.fixture, viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }\n" +
      "  other: { kind: electron, bundleId: com.kiframe.other, viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }\n"
    const { studio } = studioWith(undefined, twice)
    const shot = JSON.stringify(await run(studio, "snapshot", {}))
    // The snapshot as the agent gets it (JSON: its quotes escaped).
    const ref = /button \\?"Add note\\?" \[ref=(e\d+)\]/.exec(shot)?.[1]
    expect(ref).toBeDefined()
    const step = JSON.stringify(
      await run(studio, "run_step", {
        scene: "s",
        start_app: "other",
        step: { id: "add", action: "click", target: { ref } },
      }),
    )
    expect(step).toMatch(/snapshot/)
    expect(step).not.toContain("Notes: 1")
  })

  it("stops a launch with the tool that asked for it", async () => {
    let seen: AbortSignal | undefined
    const { studio } = studioWith((_app, signal) => {
      seen = signal
      return new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason as Error)),
      )
    })
    const stopping = new AbortController()
    const step = tool("run_step").run(
      { scene: "s", start_app: "notes", step: { id: "a", action: "pause", ms: 1 } },
      studio,
      stopping.signal,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    stopping.abort()
    await expect(step).rejects.toMatchObject({ name: "AbortError" })
    expect(seen?.aborted).toBe(true)
  })
})
