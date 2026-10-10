import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, TakeStore } from "@kiframe/project"
import { parseProjectYaml } from "@kiframe/schema"
import type { Browser } from "playwright"
import { describe, expect, it } from "vitest"
import { Studio, studioTools, systemPrompt, whereOf } from "../src/index.ts"

// A desktop Electron app among the project's apps (design 2026-10-08): said to the agent as such,
// no secrets on it, never grounded as a web page until its driver lands.

function studioWith(appsYaml: string) {
  const dir = join(mkdtempSync(join(tmpdir(), "kiframe-desk-")), "demo.kiframe")
  const project = createProject(dir, { id: "p1", name: "Demo", url: "https://app.test" })
  const secretsAsked: string[] = []
  const opened: string[] = []
  const browser = {
    newContext: () =>
      Promise.resolve({
        newPage: () =>
          Promise.resolve({
            goto: (url: string) => {
              opened.push(url)
              return Promise.resolve(null)
            },
          }),
        close: () => Promise.resolve(),
      }),
  } as unknown as Browser
  const studio = new Studio({
    project,
    scope: "folder-1",
    sceneKey: (id) => `host-${id}`,
    config: parseProjectYaml(`version: 2\napps:\n${appsYaml}`),
    takes: new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-desk-data-"))),
    browser,
    requestUser: () => Promise.resolve(false),
    secrets: (origin) => {
      secretsAsked.push(origin)
      return [{ name: "pw", provided: true }]
    },
    stopRun: () => undefined,
  })
  return { studio, secretsAsked, opened }
}

describe("a desktop app in the studio", () => {
  it("is said to the agent as the desktop app it is", () => {
    const one = studioWith("  notes: { kind: electron, bundleId: com.example.notes }\n")
    expect(systemPrompt(one.studio)).toContain("App: the desktop app com.example.notes")
    const two = studioWith(
      '  app: { kind: web, url: "https://app.test" }\n  notes: { kind: electron, bundleId: com.example.notes }\n',
    )
    expect(systemPrompt(two.studio)).toContain("  notes: the desktop app com.example.notes")
  })

  it("lists no secret on it (the user signs in by hand there)", async () => {
    const { studio, secretsAsked } = studioWith(
      '  app: { kind: web, url: "https://app.test" }\n  notes: { kind: electron, bundleId: com.example.notes }\n',
    )
    const tool = studioTools.find((t) => t.name === "list_secrets")!
    await tool.run({}, studio, new AbortController().signal)
    expect(secretsAsked).toEqual(["https://app.test"])
  })

  it("is never grounded as a web page without a desktop launcher: said, never a page opened", async () => {
    const alone = studioWith("  notes: { kind: electron, bundleId: com.example.notes }\n")
    await expect(alone.studio.livePage()).rejects.toThrow(
      /"notes" is a desktop app: none can be opened here/,
    )
    expect(alone.opened).toEqual([])
    // Listed first, beside a web app: the live page opens on the web app.
    const both = studioWith(
      '  notes: { kind: electron, bundleId: com.example.notes }\n  app: { kind: web, url: "https://app.test" }\n',
    )
    await both.studio.livePage()
    expect(both.opened).toEqual(["https://app.test"])
    // A step grounded in the desktop app: refused, said why.
    const tool = studioTools.find((t) => t.name === "run_step")!
    expect(
      await tool.run(
        { scene: "s", step: { id: "a", action: "pause", ms: 1 }, start_app: "notes" },
        both.studio,
        new AbortController().signal,
      ),
    ).toEqual({
      error: 'start_app: "notes" is a desktop app: none can be grounded here',
    })
  })

  it("names the app in a step's place whenever the project has several (a desktop one too)", () => {
    const apps = { app: { url: "https://app.test" } }
    expect(whereOf("https://app.test/dash", apps, "app", true)).toBe("app: /dash")
    expect(whereOf("https://app.test/dash", apps, "app")).toBe("/dash")
  })
})
