import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseScenarioYaml, type Scenario, type Scene, TakeMeta } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import {
  createProject,
  openProject,
  ProjectChangedError,
  removeScene,
  reorderScenes,
  saveScene,
  TakeStore,
} from "../src/index.ts"

const folder = () => join(mkdtempSync(join(tmpdir(), "kiframe-project-")), "demo.kiframe")
const scene = (id: string, title = id): Scene => ({
  version: 1,
  id,
  title,
  source: { kind: "recording" },
  duration: { mode: "auto" },
})
const scenario = parseScenarioYaml(
  "version: 1\nsteps:\n  - { id: open, action: goto, url: /projects }\n",
)

describe("project store", () => {
  it("creates a project, saves scenes with their scenario, and opens them back", () => {
    const dir = folder()
    const made = createProject(dir, { id: "p1", name: "Q4 release", url: "https://app.test" })
    saveScene(made, scene("login", "Log in"), { scenario })
    saveScene(made, scene("create"))
    const opened = openProject(dir)
    expect(opened.problems).toEqual([])
    expect(opened.project.sequence).toEqual(["login", "create"])
    expect(opened.scenes.get("login")?.scene.title).toBe("Log in")
    expect(opened.scenes.get("login")?.scenario).toEqual(scenario)
    expect(opened.scenes.get("create")?.scenario).toBeUndefined()
    // Stable, readable JSON on disk.
    expect(readFileSync(join(dir, "project.json"), "utf8")).toMatch(/^\{\n {2}"version": 1,/)
  })

  it("refuses to create over an existing project, or to write an invalid scene", () => {
    const dir = folder()
    const made = createProject(dir, { id: "p1", name: "Q4", url: "https://app.test" })
    expect(() => createProject(dir, { id: "p2", name: "X", url: "https://app.test" })).toThrow(
      /already holds a project/,
    )
    expect(() => saveScene(made, { ...scene("bad"), title: "" })).toThrow()
    expect(openProject(dir).scenes.size).toBe(0)
  })

  it("keeps a scene's scenario when only its object changes, and removes it on null", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    saveScene(made, scene("login"), { scenario })
    saveScene(made, scene("login", "Sign in"))
    expect(openProject(made.dir).scenes.get("login")?.scenario).toEqual(scenario)
    saveScene(made, scene("login"), { scenario: null })
    expect(openProject(made.dir).scenes.get("login")?.scenario).toBeUndefined()
  })

  it("reorders and removes scenes (outputs follow)", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    for (const id of ["a", "b", "c"]) saveScene(made, scene(id))
    reorderScenes(made, ["c", "a", "b"])
    expect(() => reorderScenes(made, ["a", "b"])).toThrow(/exactly the scenes/)
    removeScene(made, "a")
    const opened = openProject(made.dir)
    expect(opened.project.sequence).toEqual(["c", "b"])
    expect([...opened.scenes.keys()].sort()).toEqual(["b", "c"])
  })

  it("reports a broken scene folder and still opens the rest", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    saveScene(made, scene("good"))
    saveScene(made, scene("broken"))
    writeFileSync(join(made.dir, "scenes", "broken", "scene.json"), "{ not json")
    const opened = openProject(made.dir)
    expect([...opened.scenes.keys()]).toEqual(["good"])
    expect(opened.problems.map((p) => p.sceneId)).toEqual(["broken"])
  })
})

describe("project store: failures and conflicts", () => {
  it("writes nothing when any part is invalid (a new scene stays out)", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    const bad = { version: 1, steps: [{ id: "x", action: "nope" }] } as unknown as Scenario
    expect(() => saveScene(made, scene("checkout"), { scenario: bad })).toThrow()
    expect(existsSync(join(made.dir, "scenes", "checkout"))).toBe(false)
    expect(openProject(made.dir).project.sequence).toEqual([])
    // An existing scene: neither its title nor its scenario changes.
    saveScene(made, scene("login", "Log in"), { scenario })
    expect(() => saveScene(made, scene("login", "Sign in"), { scenario: bad })).toThrow()
    const login = openProject(made.dir).scenes.get("login")
    expect(login?.scene.title).toBe("Log in")
    expect(login?.scenario).toEqual(scenario)
  })

  it("never overwrites a change made on disk since the project was read", () => {
    const dir = folder()
    createProject(dir, { id: "p1", name: "Q4", url: "https://app.test" })
    const a = openProject(dir)
    const b = openProject(dir)
    saveScene(b, scene("intro"))
    expect(() => saveScene(a, scene("outro"))).toThrow(ProjectChangedError)
    expect(openProject(dir).project.sequence).toEqual(["intro"])
  })

  it("reports a scene folder outside the sequence", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    saveScene(made, scene("a"))
    mkdirSync(join(made.dir, "scenes", "stray"))
    writeFileSync(join(made.dir, "scenes", "stray", "scene.json"), JSON.stringify(scene("stray")))
    expect(openProject(made.dir).problems).toEqual([
      { sceneId: "stray", message: "a scene folder that isn't in the sequence" },
    ])
  })

  it("reads a scene's parts on their own, and repairs only the broken one", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    saveScene(made, scene("login", "Log in"), { scenario })
    writeFileSync(join(made.dir, "scenes", "login", "composition.json"), "{ bad")
    const opened = openProject(made.dir)
    // The good parts still load; the broken one is named.
    expect(opened.scenes.get("login")?.scenario).toEqual(scenario)
    expect(opened.problems).toEqual([
      expect.objectContaining({ sceneId: "login", part: "composition" }),
    ])
    expect(() => saveScene(opened, scene("login", "Sign in"))).toThrow(
      /composition.json didn't read/,
    )
    saveScene(opened, scene("login", "Sign in"), { composition: null })
    const back = openProject(made.dir)
    expect(back.problems).toEqual([])
    expect(back.scenes.get("login")?.scenario).toEqual(scenario)
  })

  it("never overwrites a scene file changed on disk (a hand edit, a git pull)", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    saveScene(made, scene("login"), { scenario })
    const pulled = "version: 1\nsteps:\n  - { id: other, action: goto, url: /other }\n"
    writeFileSync(join(made.dir, "scenes", "login", "scenario.yaml"), pulled)
    expect(() => saveScene(made, scene("login", "Sign in"), { scenario })).toThrow(
      ProjectChangedError,
    )
    expect(() => removeScene(made, "login")).toThrow(ProjectChangedError)
    expect(readFileSync(join(made.dir, "scenes", "login", "scenario.yaml"), "utf8")).toBe(pulled)
  })

  it("removes stray temporary files on open", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    writeFileSync(join(made.dir, ".0123456789ab.tmp"), "x")
    openProject(made.dir)
    expect(existsSync(join(made.dir, ".0123456789ab.tmp"))).toBe(false)
  })
})

describe("take store", () => {
  const meta = (key: string, recordedAt: string, hash = "h", status = "complete") =>
    TakeMeta.parse({
      version: 1,
      takeKey: key,
      scenarioHash: hash,
      recordedAt,
      appUrl: "https://app.test",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
      frameSize: { width: 800, height: 600 },
      fps: 30,
      durationMs: 1000,
      kiframeVersion: "0",
      outcome: status === "complete" ? { status } : { status, error: "step open failed" },
    })
  // Stands in for recordScenario: writes a take into outDir (or fails like it does).
  const recorder =
    (m: TakeMeta, fail = false) =>
    (outDir: string) => {
      const dir = fail ? `${outDir}.failed` : outDir
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "frames.webm"), "raw frames")
      writeFileSync(join(dir, "meta.json"), JSON.stringify(m))
      return fail ? Promise.reject(new Error("step open failed")) : Promise.resolve({ meta: m })
    }
  const newStore = () => new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-")))

  it("files complete takes privately under their key, newest first by time", async () => {
    const store = newStore()
    await store.record("p1", "login", recorder(meta("aaaa-100", "2026-09-30T11:00:00Z")))
    // Earlier in UTC although it sorts later as text.
    await store.record("p1", "login", recorder(meta("aaaa-50", "2026-09-30T12:30:00+02:00")))
    const newest = await store.record(
      "p1",
      "login",
      recorder(meta("bbbb-200", "2026-09-30T11:30:00Z")),
    )
    // What the recorder returned, pointing where the take is now.
    expect(newest.recorded.meta.takeKey).toBe("bbbb-200")
    expect((newest.recorded as { dir?: string }).dir).toBe(newest.dir)
    expect(store.takes("p1", "login").map((t) => t.meta.takeKey)).toEqual([
      "bbbb-200",
      "aaaa-100",
      "aaaa-50",
    ])
    expect(statSync(newest.dir).mode & 0o777).toBe(0o700)
    // The newest complete take.
    expect(store.latest("p1", "login")?.meta.takeKey).toBe("bbbb-200")
    expect(store.latest("p1", "other")).toBeUndefined()
    expect(store.take("p1", "login", "aaaa-50")?.meta.takeKey).toBe("aaaa-50")
    expect(store.take("p1", "login", "../x")).toBeUndefined()
  })

  it("sweeps a crash's cut-short recording, never one under way (whichever store sweeps)", async () => {
    const store = newStore()
    await store.record("p1", "login", recorder(meta("aaaa-1", "2026-09-30T11:00:00Z")))
    const login = join(store.root, "takes", "p1", "login")
    // A crashed run's, with the recorder's staging folder.
    mkdirSync(join(login, ".recording-deadbeef0000"))
    mkdirSync(join(login, "..recording-deadbeef0000.recording-1-2"))
    let during: string[] = []
    await store.record("p1", "login", (outDir) => {
      // Under way: another store of this process sweeping now leaves it alone.
      mkdirSync(outDir, { recursive: true })
      new TakeStore(store.root).sweepLeftovers("p1")
      during = readdirSync(login)
      return recorder(meta("aaaa-2", "2026-09-30T11:05:00Z"))(outDir)
    })
    expect(during.filter((n) => n.startsWith("."))).toHaveLength(1)
    expect(readdirSync(login).sort()).toEqual(["aaaa-1", "aaaa-2"])
  })

  it("fails only the scene that can't be set up in a batch", async () => {
    const store = newStore()
    const results = await store.recordMany("p1", ["login", "Not An Id"], async ([a, b]) => {
      expect(b).toBeUndefined()
      return [
        { ok: true, take: await recorder(meta("aaaa-1", "2026-09-30T11:00:00Z"))(a ?? "") },
        { ok: false, error: new Error("not recorded") },
      ]
    })
    expect(results.map((r) => r.ok)).toEqual([true, false])
  })

  it("records a batch: each complete take filed, each failed one discarded", async () => {
    const store = newStore()
    const results = await store.recordMany("p1", ["login", "create"], async ([a, b]) => [
      { ok: true, take: await recorder(meta("aaaa-1", "2026-09-30T11:00:00Z"))(a ?? "") },
      await recorder(
        meta("aaaa-2", "2026-09-30T11:00:00Z"),
        true,
      )(b ?? "").then(
        (take) => ({ ok: true as const, take }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ])
    expect(results.map((r) => r.ok)).toEqual([true, false])
    expect(store.latest("p1", "login")?.meta.takeKey).toBe("aaaa-1")
    expect(readdirSync(join(store.root, "takes", "p1", "create"))).toEqual([])
  })

  it("deletes a failed recording's raw frames, and a scene's takes with it", async () => {
    const store = newStore()
    await expect(
      store.record("p1", "login", recorder(meta("aaaa-1", "2026-09-30T11:00:00Z"), true)),
    ).rejects.toThrow(/step open failed/)
    const scene = join(store.root, "takes", "p1", "login")
    expect(readdirSync(scene)).toEqual([])
    await store.record("p1", "login", recorder(meta("aaaa-1", "2026-09-30T11:00:00Z")))
    store.removeScene("p1", "login")
    expect(existsSync(scene)).toBe(false)
  })
})
