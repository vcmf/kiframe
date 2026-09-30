import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseScenarioYaml, type Scene } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import {
  createProject,
  openProject,
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

describe("take store", () => {
  const meta = (key: string, recordedAt: string, status = "complete") => ({
    version: 1,
    takeKey: key,
    scenarioHash: "h",
    recordedAt,
    appUrl: "https://app.test",
    viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    frameSize: { width: 800, height: 600 },
    fps: 30,
    durationMs: 1000,
    kiframeVersion: "0",
    outcome: status === "complete" ? { status } : { status, error: "step open failed" },
  })

  it("files recorded takes privately under their key and lists complete ones newest first", () => {
    const store = new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-")))
    const record = (key: string, at: string, status?: string) => {
      const dir = store.recordingDir("p1", "login")
      mkdirSync(dir)
      writeFileSync(join(dir, "meta.json"), JSON.stringify(meta(key, at, status)))
      return store.keep(dir)
    }
    record("k-old", "2026-09-30T10:00:00.000Z")
    const newest = record("k-new", "2026-09-30T11:00:00.000Z")
    record("k-failed", "2026-09-30T12:00:00.000Z", "failed")
    expect(store.takes("p1", "login").map((t) => t.meta.takeKey)).toEqual(["k-new", "k-old"])
    expect(store.latest("p1", "login")?.dir).toBe(newest.dir)
    expect(statSync(newest.dir).mode & 0o777).toBe(0o700)
    expect(store.latest("p1", "other")).toBeUndefined()
  })
})
