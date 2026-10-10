import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, saveScene, TakeStore } from "@kiframe/project"
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
    await expect(alone.studio.livePage(undefined, new AbortController().signal)).rejects.toThrow(
      /"notes" is a desktop app: none can be opened here/,
    )
    expect(alone.opened).toEqual([])
    // Listed first, beside a web app: the live page opens on the web app.
    const both = studioWith(
      '  notes: { kind: electron, bundleId: com.example.notes }\n  app: { kind: web, url: "https://app.test" }\n',
    )
    await both.studio.livePage(undefined, new AbortController().signal)
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
    await two.studio.livePage("app", new AbortController().signal)
    await two.studio.livePage("docs", new AbortController().signal)
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

    it("refuses a call while another call's launch goes on (never joined)", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const notes = studio.livePage("notes", new AbortController().signal)
      await expect.poll(() => fake.pending.length).toBe(1)
      await expect(studio.livePage("other", new AbortController().signal)).rejects.toThrow(
        /"notes" is still opening/,
      )
      await expect(studio.livePage("notes", new AbortController().signal)).rejects.toThrow(
        /still opening/,
      )
      fake.pending[0]?.go()
      expect((await notes).url()).toBe("app://notes/")
    })

    it("keeps a refusal the user settles through the tool (the agent tells them, never retries)", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const snapshot = studioTools.find((t) => t.name === "snapshot")!
      const seen = snapshot.run({}, studio, new AbortController().signal)
      await expect.poll(() => fake.pending.length).toBe(1)
      fake.pending[0]?.fail(
        Object.assign(new Error("notes: approved for another project"), { needsUser: true }),
      )
      await expect(seen).rejects.toMatchObject({
        message: expect.stringMatching(/approved for another project/) as string,
        needsUser: true,
      })
    })

    it("ends a launch its caller stopped (never live), and the next call goes on", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const stopping = new AbortController()
      const stopped = studio.livePage("notes", stopping.signal)
      await expect.poll(() => fake.pending.length).toBe(1)
      stopping.abort()
      // The launch sees the stop (its trial and spawn end).
      expect(fake.pending[0]?.signal.aborted).toBe(true)
      // The next call (the user's next message) comes while it's still winding down: waited
      // out, never refused.
      const next = studio.livePage("other", new AbortController().signal)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fake.pending).toHaveLength(1)
      fake.pending[0]?.fail(stopping.signal.reason as Error)
      await expect(stopped).rejects.toMatchObject({ name: "AbortError" })
      await expect.poll(() => fake.pending.length).toBe(2)
      fake.pending[1]?.go()
      expect((await next).url()).toBe("app://other/")
      expect(studio.currentPage?.url()).toBe("app://other/")
    })

    it("closes a launch that finished after its caller stopped (never kept)", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const stopping = new AbortController()
      const stopped = studio.livePage("notes", stopping.signal)
      await expect.poll(() => fake.pending.length).toBe(1)
      stopping.abort()
      // It finishes anyway (a launch that ignored the stop): closed, never live.
      fake.pending[0]?.go()
      await expect(stopped).rejects.toMatchObject({ name: "AbortError" })
      expect(fake.closed).toEqual(["notes"])
      expect(studio.currentPage).toBeUndefined()
    })

    it("keeps no app removed while it launched", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const opening = studio.livePage("notes", new AbortController().signal)
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

    it("stops a snapshot's launch with the snapshot (the agent's first call)", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const stopping = new AbortController()
      const shot = studioTools.find((t) => t.name === "snapshot")!.run({}, studio, stopping.signal)
      await expect.poll(() => fake.pending.length).toBe(1)
      stopping.abort()
      expect(fake.pending[0]?.signal.aborted).toBe(true)
      fake.pending[0]?.fail(stopping.signal.reason as Error)
      await expect(shot).rejects.toMatchObject({ name: "AbortError" })
    })

    it("never checks a scene in an app removed while it launched", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const checked = studio.check(`version: 1
app: notes
steps:
  - { id: a, action: pause, ms: 1 }
  - { id: b, action: pause, ms: 1 }
  - { id: c, action: pause, ms: 1 }
  - { id: d, action: pause, ms: 1 }
  - { id: e, action: pause, ms: 1 }
`)
      if ("error" in checked) throw new Error(checked.error)
      const replay = studio.replay(checked.scenario, "s", new AbortController().signal)
      await expect.poll(() => fake.pending.length).toBe(1)
      studio.setApps(
        parseProjectYaml(
          "version: 2\napps:\n  other: { kind: electron, bundleId: com.example.other }\n",
        ).apps,
      )
      fake.pending[0]?.go()
      expect(await replay).toMatch(/was removed/)
      expect(fake.closed).toEqual(["notes"])
    })

    const fiveSteps = `version: 1
app: notes
steps:
  - { id: a, action: pause, ms: 1 }
  - { id: b, action: pause, ms: 1 }
  - { id: c, action: pause, ms: 1 }
  - { id: d, action: pause, ms: 1 }
  - { id: e, action: pause, ms: 1 }
`

    it("ends a check stopped while its app launched as a stop, never as a failed check", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const checked = studio.check(fiveSteps)
      if ("error" in checked) throw new Error(checked.error)
      const stopping = new AbortController()
      const replay = studio.replay(checked.scenario, "s", stopping.signal)
      await expect.poll(() => fake.pending.length).toBe(1)
      stopping.abort()
      fake.pending[0]?.fail(stopping.signal.reason as Error)
      await expect(replay).rejects.toMatchObject({ name: "AbortError" })
    })

    it("closes the live copy of the app before a check launches another (one at a time)", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const live = studio.livePage("notes", new AbortController().signal)
      await expect.poll(() => fake.pending.length).toBe(1)
      fake.pending[0]?.go()
      await live
      const checked = studio.check(fiveSteps)
      if ("error" in checked) throw new Error(checked.error)
      const replay = studio.replay(checked.scenario, "s", new AbortController().signal)
      await expect.poll(() => fake.pending.length).toBe(2)
      // The live one closed before the check's launch began.
      expect(fake.closed).toEqual(["notes"])
      expect(studio.currentPage).toBeUndefined()
      fake.pending[1]?.fail(new Error("done"))
      await replay
    })

    it("leaves no app running when a recording's take folder can't be made", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const checked = studio.check(fiveSteps)
      if ("error" in checked) throw new Error(checked.error)
      saveScene(
        studio.project,
        {
          version: 1,
          id: "s",
          title: "S",
          source: { kind: "recording" },
          duration: { mode: "auto" },
        },
        { scenario: checked.scenario },
      )
      studio.options.takes.newTakeDir = () => {
        throw Object.assign(new Error("no space"), { code: "ENOSPC" })
      }
      const recording = studio.record("s", new AbortController().signal)
      await expect.poll(() => fake.pending.length).toBe(1)
      fake.pending[0]?.go()
      expect(await recording).toMatchObject({ ok: false })
      expect(fake.closed).toEqual(["notes"])
    })

    it("closes a live app the project now lists as another app under its name", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const live = studio.livePage("notes", new AbortController().signal)
      await expect.poll(() => fake.pending.length).toBe(1)
      fake.pending[0]?.go()
      await live
      studio.setApps(
        parseProjectYaml(
          "version: 2\napps:\n  notes: { kind: electron, bundleId: com.example.another }\n",
        ).apps,
      )
      // A call meanwhile never gets the old one's page: a new launch, of the app now listed.
      const next = studio.livePage("notes", new AbortController().signal)
      await expect.poll(() => fake.closed).toEqual(["notes"])
      await expect.poll(() => fake.pending.length).toBe(2)
      fake.pending[1]?.go()
      await next
      expect(fake.closed).toEqual(["notes"])
    })

    it("checks a step before launching anything for it", async () => {
      const fake = launcher()
      const studio = desktopStudio(fake, two)
      const step = await studio.runStep(
        { ensure: [{ action: "pause", ms: 1 }] },
        "s",
        new AbortController().signal,
        "steps",
        "notes",
      )
      expect(step.ok).toBe(false)
      expect(fake.pending).toEqual([])
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

  it("never keeps a web app's page removed while it loaded", async () => {
    let loaded: () => void = () => undefined
    const made = studioWith(
      '  app: { kind: web, url: "https://app.test" }\n  docs: { kind: web, url: "https://docs.test" }\n',
    )
    const browser = {
      newContext: () =>
        Promise.resolve({
          newPage: () =>
            Promise.resolve({
              goto: () => new Promise((resolve) => (loaded = () => resolve(null))),
              isClosed: () => false,
            }),
          close: () => Promise.resolve(),
        }),
    }
    ;(made.studio as unknown as { options: { browser: unknown } }).options.browser = browser
    const opening = made.studio.livePage("docs", new AbortController().signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    made.studio.setApps(
      parseProjectYaml('version: 2\napps:\n  app: { kind: web, url: "https://app.test" }\n').apps,
    )
    loaded()
    await expect(opening).rejects.toThrow(/was removed/)
    expect(made.studio.currentPage).toBeUndefined()
  })
})
