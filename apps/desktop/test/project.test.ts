import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, openProject, saveScene } from "@kiframe/project"
import { parseScenarioYaml } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import {
  appOriginOf,
  appRemovalRefused,
  interruptsUsing,
  presetsUsing,
  removeApp,
  scenesUsing,
  newProjectDir,
  projectFileName,
  projectView,
  targetUrl,
} from "../src/main/project.ts"

const folder = () => join(mkdtempSync(join(tmpdir(), "kiframe-desktop-")), "demo.kiframe")
const recording = (id: string, title: string) => ({
  version: 1 as const,
  id,
  title,
  source: { kind: "recording" as const },
  duration: { mode: "auto" as const },
})

describe("the open project", () => {
  it("shows each scene's status, in story order", () => {
    const project = createProject(folder(), { id: "p1", name: "Demo", url: "https://app.test" })
    saveScene(project, recording("empty", "No steps"))
    saveScene(project, recording("grounded", "Grounded"), {
      scenario: parseScenarioYaml("version: 1\nsteps: [{ id: a, action: pause, ms: 1 }]\n"),
    })
    saveScene(project, {
      version: 1,
      id: "intro",
      title: "Intro",
      source: { kind: "card", template: "title", content: { heading: "Hi" } },
      duration: { mode: "auto" },
    })
    expect(projectView(project, "s1")).toMatchObject({
      name: "Demo",
      url: "https://app.test",
      scenes: [
        { id: "empty", status: "empty" },
        { id: "grounded", status: "grounded" },
        { id: "intro", status: "card" },
      ],
      problems: [],
    })
  })

  it("shows a scene whose scene.json didn't read, and says why", () => {
    const dir = folder()
    createProject(dir, { id: "p1", name: "Demo", url: "https://app.test" })
    mkdirSync(join(dir, "scenes", "broken"), { recursive: true })
    writeFileSync(join(dir, "scenes", "broken", "scene.json"), "{ not json")
    const view = projectView(openProject(dir), "s1")
    expect(view?.scenes).toEqual([
      {
        id: "broken",
        title: "broken",
        status: "unreadable",
        problem: expect.any(String) as unknown,
      },
    ])
    expect(view?.problems.some((p) => p.startsWith("broken:"))).toBe(true)
  })

  it("never hides a scene whose scenario didn't read, nor one whose folder is gone", () => {
    const dir = folder()
    const project = createProject(dir, { id: "p1", name: "Demo", url: "https://app.test" })
    saveScene(project, recording("broken", "Broken"), {
      scenario: parseScenarioYaml("version: 1\nsteps: [{ id: a, action: pause, ms: 1 }]\n"),
    })
    saveScene(project, recording("gone", "Gone"))
    writeFileSync(join(dir, "scenes", "broken", "scenario.yaml"), "steps: [")
    rmSync(join(dir, "scenes", "gone"), { recursive: true })
    const view = projectView(openProject(dir), "s1")
    expect(view.scenes).toMatchObject([
      {
        id: "broken",
        title: "Broken",
        status: "unreadable",
        problem: expect.any(String) as unknown,
      },
      { id: "gone", status: "missing" },
    ])
    expect(view.problems).toHaveLength(2)
  })

  it("puts a new project in a new or empty folder only", () => {
    const parent = mkdtempSync(join(tmpdir(), "kiframe-new-"))
    expect(newProjectDir(join(parent, "Demo"))).toBe(join(parent, "Demo.kiframe"))
    expect(newProjectDir(join(parent, "Demo.KIFRAME"))).toBe(join(parent, "Demo.KIFRAME"))
    mkdirSync(join(parent, "empty.kiframe"))
    expect(newProjectDir(join(parent, "empty.kiframe"))).toBe(join(parent, "empty.kiframe"))
    mkdirSync(join(parent, "work.kiframe"))
    writeFileSync(join(parent, "work.kiframe", "notes.txt"), "mine")
    expect(() => newProjectDir(join(parent, "work"))).toThrow(/isn't an empty folder/)
    writeFileSync(join(parent, "file.kiframe"), "x")
    expect(() => newProjectDir(join(parent, "file.kiframe"))).toThrow(/isn't an empty folder/)
  })

  it("names a project's folder safely, and checks its address by the project's rule", () => {
    expect(projectFileName("Q3/Q4 demo")).toBe("Q3 Q4 demo.kiframe")
    expect(projectFileName("..")).toBe("Untitled.kiframe")
    expect(projectFileName(". Demo")).toBe("Demo.kiframe")
    expect(projectFileName("CON")).toBe("CON project.kiframe")
    expect(projectFileName("nul")).toBe("nul project.kiframe")
    expect(projectFileName("nul.tar")).toBe("nul project.tar.kiframe")
    expect(projectFileName("con.")).toBe("con project.kiframe")
    expect(projectFileName("COM¹")).toBe("COM¹ project.kiframe")
    expect(projectFileName("console")).toBe("console.kiframe")
    expect(Buffer.byteLength(projectFileName(`nul.${"演".repeat(110)}`))).toBeLessThanOrEqual(255)
    const long = projectFileName("演".repeat(120))
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255)
    expect(long.endsWith(".kiframe")).toBe(true)
    expect(projectFileName('a:b*c?"d<e>f|g\\h')).toBe("a b c d e f g h.kiframe")
    expect(targetUrl(" https://app.test/x ")).toBe("https://app.test/x")
    expect(() => targetUrl("https://u:p@app.test")).toThrow(/credentials/)
    expect(() => targetUrl("file:///etc/passwd")).toThrow(/App address/)
    expect(() => targetUrl("not a url")).toThrow(/App address/)
  })
})

describe("a request of the window for one of the project's apps", () => {
  const view = {
    session: "s1",
    apps: [
      { name: "app", origin: "https://app.test" },
      { name: "docs", origin: "https://docs.test" },
    ],
  }

  it("gives the app's exact origin, found by its name in the project (never the window's)", () => {
    expect(appOriginOf(view, "s1", "docs")).toEqual({ name: "docs", origin: "https://docs.test" })
  })

  it("refuses an app the project doesn't list, a request from another opening, or no project", () => {
    expect(appOriginOf(view, "s1", "admin")).toEqual({
      why: "\"admin\" isn't one of the project's apps",
    })
    expect(appOriginOf(view, "s0", "docs")).toEqual({
      why: "the project changed meanwhile: try again",
    })
    expect(appOriginOf(undefined, "s1", "app")).toEqual({ why: "open a project first" })
  })

  it("shows every app with its exact origin (main's: the window never derives one)", () => {
    const project = createProject(folder(), {
      id: "p1",
      name: "Demo",
      url: "https://www.app.test/home",
    })
    expect(projectView(project, "s1").apps).toEqual([
      { name: "app", origin: "https://www.app.test" },
    ])
  })
})

describe("removing one of the project's apps (B5)", () => {
  /** A project with app, docs and auth, its scenes using them in several ways. */
  const threeApps = () => {
    const dir = folder()
    const made = createProject(dir, { id: "p1", name: "Demo", url: "https://app.test" })
    const file = join(dir, "project.json")
    const project = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    writeFileSync(
      file,
      JSON.stringify({
        ...project,
        apps: {
          app: { kind: "web", url: "https://app.test" },
          docs: { kind: "web", url: "https://docs.test" },
          auth: { kind: "web", url: "https://auth.test" },
        },
        presets: { login: { app: "auth", steps: [{ action: "goto", url: "/in" }] } },
        interrupts: [
          { id: "moved", when: { text: "Moved" }, do: { action: "goto", app: "docs", url: "/" } },
        ],
      }),
    )
    const opened = openProject(dir)
    const yaml = (body: string) => parseScenarioYaml(`version: 1\n${body}`)
    const pause = "steps: [{ id: a, action: pause, ms: 1 }]"
    saveScene(opened, recording("starts", "Starts in docs"), {
      scenario: yaml(`app: docs\n${pause}`),
    })
    saveScene(opened, recording("goes", "Goes to docs"), {
      scenario: yaml("steps: [{ id: a, action: goto, app: docs, url: / }]"),
    })
    saveScene(opened, recording("waits", "Waits on docs"), {
      scenario: yaml("steps: [{ id: a, action: waitFor, until: { url: /, app: docs } }]"),
    })
    saveScene(opened, recording("logs", "Logs in"), {
      scenario: yaml(`setup: [{ preset: login }]\n${pause}`),
    })
    saveScene(opened, recording("plain", "Plain"), { scenario: yaml(pause) })
    expect(made.dir).toBe(dir)
    return { dir, opened }
  }

  it("names the scenes that use an app: start, goto, URL condition, a preset they use", () => {
    const { opened } = threeApps()
    expect(scenesUsing(opened, "docs")).toEqual(["Starts in docs", "Goes to docs", "Waits on docs"])
    expect(scenesUsing(opened, "auth")).toEqual(["Logs in"])
    expect(presetsUsing(opened, "auth")).toEqual(["login"])
    expect(presetsUsing(opened, "docs")).toEqual([])
    expect(interruptsUsing(opened, "docs")).toEqual(["moved"])
    expect(interruptsUsing(opened, "auth")).toEqual([])
    // A scene outside the story order counts too.
    opened.project = {
      ...opened.project,
      sequence: opened.project.sequence.filter((id) => id !== "goes"),
    }
    expect(scenesUsing(opened, "docs")).toEqual(["Starts in docs", "Waits on docs", "Goes to docs"])
  })

  it("removes it from project.json; never the first app; and marks the scenes that used it", () => {
    const { dir, opened } = threeApps()
    expect(() => removeApp(opened, "app")).toThrow(/where scenes start/)
    expect(() => removeApp(opened, "nope")).toThrow(/isn't one of the project's apps/)
    removeApp(opened, "docs")
    expect(Object.keys(openProject(dir).project.apps)).toEqual(["app", "auth"])
    const view = projectView(opened, "s1")
    const marked = Object.fromEntries(view.scenes.map((s) => [s.id, s.removedApps]))
    expect(marked).toEqual({
      starts: ["docs"],
      goes: ["docs"],
      waits: ["docs"],
      logs: undefined,
      plain: undefined,
    })
    // Its status kept (grounded here): the preview and the stage still find it.
    expect(view.scenes.find((s) => s.id === "starts")?.status).toBe("grounded")
  })

  it("refuses a removal while the agent works, from another opening, of a changed app, or of the first", () => {
    const view = {
      session: "s1",
      apps: [
        { name: "app", origin: "https://app.test" },
        { name: "docs", origin: "https://docs.test" },
      ],
    }
    const docs = { session: "s1", name: "docs", origin: "https://docs.test" }
    expect(appRemovalRefused(view, docs, false)).toBeNull()
    expect(appRemovalRefused(view, docs, true)).toMatch(/agent is working/)
    expect(appRemovalRefused(view, { ...docs, session: "s0" }, false)).toMatch(/project changed/)
    expect(appRemovalRefused(view, { ...docs, origin: "https://other.test" }, false)).toMatch(
      /changed meanwhile/,
    )
    expect(
      appRemovalRefused(view, { session: "s1", name: "app", origin: "https://app.test" }, false),
    ).toMatch(/where scenes start/)
  })
})
