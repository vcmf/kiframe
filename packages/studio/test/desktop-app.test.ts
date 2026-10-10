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
  const contexts: number[] = []
  const browser = {
    newContext: () => (
      contexts.push(1),
      Promise.resolve({
        newPage: () =>
          Promise.resolve({
            goto: (url: string) => {
              opened.push(url)
              return Promise.resolve(null)
            },
            isClosed: () => false,
          }),
        close: () => Promise.resolve(),
      })
    ),
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
  return { studio, secretsAsked, opened, contexts }
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

  it("keeps the live page between web apps' scenes (a sign-in by hand kept)", async () => {
    const two = studioWith(
      '  app: { kind: web, url: "https://app.test" }\n  docs: { kind: web, url: "https://docs.test" }\n',
    )
    await two.studio.livePage("app")
    await two.studio.livePage("docs")
    expect(two.contexts).toHaveLength(1)
  })

  it("never saves a desktop scene that hands something over, in a preset too", () => {
    const { studio } = studioWith(`  notes: { kind: electron, bundleId: com.example.notes }
presets:
  sign-in:
    app: notes
    steps:
      - { action: handover, task: Sign in }
`)
    const saved = studio.check(`version: 1
app: notes
setup:
  - { preset: sign-in }
steps:
  - { id: a, action: pause, ms: 1 }
  - { id: b, action: pause, ms: 1 }
  - { id: c, action: pause, ms: 1 }
  - { id: d, action: pause, ms: 1 }
  - { id: e, action: pause, ms: 1 }
`)
    expect(saved).toMatchObject({ error: expect.stringMatching(/no handover step/) as string })
  })

  describe("its live launch (a fake launcher)", () => {
    /** A launcher whose launches the test lets go of; each one's page and its close counted. */
    const launcher = () => {
      const pending: {
        app: string
        go: () => void
        fail: (e: Error) => void
        signal: AbortSignal
      }[] = []
      const closed: string[] = []
      const launch = (app: string, signal: AbortSignal) =>
        new Promise<never>((resolve, reject) => {
          const page = { isClosed: () => false, url: () => `app://${app}/`, context: () => context }
          const context = { pages: () => [page] }
          const target = {
            page,
            context,
            allows: () => true,
            stopped: () => [],
            prepare: () => Promise.resolve(),
            quiet: () => Promise.resolve(),
            close: () => (closed.push(app), Promise.resolve({ unread: false })),
          }
          pending.push({
            app,
            signal,
            go: () => resolve({ target, build: { opens: "a".repeat(64) } } as never),
            fail: reject,
          })
        })
      return { pending, closed, launch }
    }
    const desktopStudio = (fake: ReturnType<typeof launcher>, appsYaml: string) => {
      const made = studioWith(appsYaml)
      ;(made.studio as unknown as { options: { launchDesktop: unknown } }).options.launchDesktop =
        fake.launch
      return made.studio
    }
    const two =
      "  notes: { kind: electron, bundleId: com.example.notes }\n  other: { kind: electron, bundleId: com.example.other }\n"

    it("opens the app asked for, never another app's launch in progress", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const notes = studio.livePage("notes")
      const other = studio.livePage("other")
      await Promise.resolve()
      fake.pending[0]?.go()
      await notes
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fake.pending.map((p) => p.app)).toEqual(["notes", "other"])
      fake.pending[1]?.go()
      expect((await other).url()).toBe("app://other/")
      // notes closed before other opened (one app live at a time).
      expect(fake.closed).toEqual(["notes"])
    })

    it("stops only the caller that stopped (the launch goes on for the other)", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const stopping = new AbortController()
      const stopped = studio.livePage("notes", stopping.signal)
      const going = studio.livePage("notes")
      stopping.abort()
      await expect(stopped).rejects.toMatchObject({ name: "AbortError" })
      fake.pending[0]?.go()
      expect((await going).url()).toBe("app://notes/")
      expect(fake.pending[0]?.signal.aborted).toBe(false)
    })

    it("keeps no app removed while it launched", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const opening = studio.livePage("notes")
      // Removed once the launch is under way.
      await expect.poll(() => fake.pending.length).toBe(1)
      studio.setApps(
        parseProjectYaml(
          "version: 2\napps:\n  other: { kind: electron, bundleId: com.example.other }\n",
        ).apps,
      )
      await Promise.resolve()
      fake.pending[0]?.go()
      await expect(opening).rejects.toThrow(/was removed/)
      expect(fake.closed).toEqual(["notes"])
    })

    it("refuses a handover before launching anything", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      expect(
        await studio.handOver("Sign in", undefined, new AbortController().signal),
      ).toMatchObject({
        error: expect.stringMatching(/isn't handed to the user yet/) as string,
      })
      expect(fake.pending).toEqual([])
    })
  })
})
