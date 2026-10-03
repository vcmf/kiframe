import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, openProject, saveScene } from "@kiframe/project"
import { parseScenarioYaml } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import { newProjectDir, projectFileName, projectView, targetUrl } from "../src/main/project.ts"

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
