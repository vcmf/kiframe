import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, openProject, saveScene } from "@kiframe/project"
import { parseScenarioYaml } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import {
  newProjectDir,
  ProjectSession,
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
    expect(projectView(project)).toMatchObject({
      name: "Demo",
      url: "https://app.test",
      scenes: [
        { id: "empty", status: "empty", kind: "recording" },
        { id: "grounded", status: "grounded", kind: "recording" },
        { id: "intro", status: "card", kind: "card" },
      ],
      problems: [],
    })
  })

  it("shows a scene whose scene.json didn't read, and says why", () => {
    const dir = folder()
    createProject(dir, { id: "p1", name: "Demo", url: "https://app.test" })
    mkdirSync(join(dir, "scenes", "broken"), { recursive: true })
    writeFileSync(join(dir, "scenes", "broken", "scene.json"), "{ not json")
    const session = new ProjectSession()
    session.open(dir)
    const view = session.view()
    expect(view?.scenes).toEqual([
      {
        id: "broken",
        title: "broken",
        kind: "unreadable",
        status: "unreadable",
        problem: expect.any(String) as unknown,
      },
    ])
    expect(view?.problems.some((p) => p.startsWith("broken:"))).toBe(true)
  })

  it("creates one project at a time, with a fresh id, and closes it", () => {
    const session = new ProjectSession()
    const a = session.create(folder(), { name: "A", url: "https://a.test" })
    const b = session.create(folder(), { name: "B", url: "https://b.test" })
    expect(a.project.id).not.toBe(b.project.id)
    expect(session.view()?.name).toBe("B")
    session.close()
    expect(session.view()).toBeNull()
  })

  it("refuses a folder that already holds a project, and one that isn't one", () => {
    const dir = folder()
    const session = new ProjectSession()
    session.create(dir, { name: "A", url: "https://a.test" })
    expect(() => session.create(dir, { name: "A", url: "https://a.test" })).toThrow(
      /already holds a project/,
    )
    expect(() => session.open(mkdtempSync(join(tmpdir(), "kiframe-not-")))).toThrow()
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
    const view = new ProjectSession().open(dir) && projectView(openProject(dir))
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
    expect(projectFileName('a:b*c?"d<e>f|g\\h')).toBe("a b c d e f g h.kiframe")
    expect(targetUrl(" https://app.test/x ")).toBe("https://app.test/x")
    expect(() => targetUrl("https://u:p@app.test")).toThrow(/credentials/)
    expect(() => targetUrl("file:///etc/passwd")).toThrow(/App address/)
    expect(() => targetUrl("not a url")).toThrow(/App address/)
  })
})
