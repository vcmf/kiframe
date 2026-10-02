import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, saveScene } from "@kiframe/project"
import { parseScenarioYaml } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import { ProjectSession, projectView } from "../src/main/project.ts"

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
      { id: "broken", title: "broken", kind: "unreadable", status: "unreadable" },
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
})
