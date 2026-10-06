import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentEvent, type LlmClient, type LlmTurn, runAgent } from "@kiframe/agent"
import { createProject, openProject, TakeStore } from "@kiframe/project"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFixtureServer } from "../../runtime/test/fixture-server.ts"
import {
  SNAPSHOT_MAX,
  Studio,
  studioTools,
  systemPrompt,
  type UserRequest,
  siteOf,
  whereOf,
} from "../src/index.ts"

let server: Awaited<ReturnType<typeof startFixtureServer>>
let browser: Browser
beforeAll(async () => {
  server = await startFixtureServer()
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
  await server.close()
})

function makeStudio(
  answer: (r: UserRequest, signal: AbortSignal) => Promise<string | boolean> = () =>
    Promise.resolve("ok"),
  extra: Partial<ConstructorParameters<typeof Studio>[0]> = {},
) {
  const dir = join(mkdtempSync(join(tmpdir(), "kiframe-studio-")), "demo.kiframe")
  const project = createProject(dir, {
    id: "p1",
    name: "Demo",
    url: server.url,
    viewport: { width: 800, height: 600 },
  })
  const config = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
  const asked: UserRequest[] = []
  const studio = new Studio({
    project,
    scope: "folder-1",
    sceneKey: (id) => `host-${id}`,
    config,
    resolveSecret: () => "sk-live-4242424242",
    takes: new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-"))),
    browser,
    requestUser: (request, signal) => {
      asked.push(request)
      return answer(request, signal)
    },
    ...extra,
  })
  return { studio, asked, dir }
}

const tool = (name: string) => {
  const found = studioTools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return found
}
const never = new AbortController().signal

const SCENE = `version: 1
setup: [{ action: goto, url: / }]
steps:
  - { id: look, action: pause, ms: 20 }
  - { id: open, action: click, target: { by: role, role: link, name: Projects }, caption: "Open your projects" }
  - { id: seen, action: expect, that: { url: /projects } }
  - { id: heading, action: expect, that: { visible: { by: role, role: heading, name: Projects } } }
  - { id: beat, action: pause, ms: 20 }
`

describe("studio tools", () => {
  it("snapshots the live page and runs a step on it", async () => {
    const { studio } = makeStudio()
    const snap = (await tool("snapshot").run({}, studio, never)) as string
    expect(snap).toMatch(/^url: \//)
    expect(snap).toMatch(/Welcome/)
    expect(
      await tool("run_step").run(
        {
          scene: "tour",
          step: {
            id: "open",
            action: "click",
            target: { by: "role", role: "link", name: "Projects" },
          },
        },
        studio,
        never,
      ),
    ).toMatch(/^ok\. url: \/projects/)
    expect(
      await tool("run_step").run(
        {
          scene: "tour",
          step: {
            id: "x",
            action: "click",
            target: { by: "role", role: "button", name: "Nothing" },
          },
        },
        studio,
        never,
      ),
    ).toEqual({ error: expect.stringMatching(/^failed \(/) as unknown })
    await studio.close()
  }, 30_000)

  it("saves a scene only once its replay passes, then records it with its composition", async () => {
    let tidied = 0
    const { studio, dir } = makeStudio(undefined, { afterRecord: () => (tidied += 1) })
    expect(
      await tool("save_scene").run(
        {
          id: "tour",
          title: "Tour",
          yaml: "version: 1\nsteps: [{ id: a, action: pause, ms: 1 }]\n",
        },
        studio,
        never,
      ),
    ).toMatchObject({ error: expect.stringMatching(/5-15/) as unknown })
    expect(
      await tool("save_scene").run(
        { id: "tour", title: "Tour", notes: "Opening projects", yaml: SCENE },
        studio,
        never,
      ),
    ).toMatch(/^saved/)
    expect(await tool("list_scenes").run({}, studio, never)).toEqual([
      { id: "tour", title: "Tour", grounded: true, recorded: false },
    ])
    expect(tidied).toBe(0)
    expect(await tool("record_scene").run({ id: "tour" }, studio, never)).toMatch(/^recorded/)
    // The host's take bookkeeping, once the composition naming the take is saved.
    expect(tidied).toBe(1)
    const reopened = openProject(dir)
    expect(reopened.scenes.get("tour")?.composition?.take?.key).toBe(
      studio.options.takes.latest("p1", "tour")?.meta.takeKey,
    )
  }, 60_000)

  it("asks the user, and a question the stop closes ends the call aborted", async () => {
    const { studio, asked } = makeStudio(
      (_r, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("dialog closed")))
        }),
    )
    const controller = new AbortController()
    const llm: LlmClient = {
      complete: (_m, _t) =>
        Promise.resolve<LlmTurn>({
          kind: "tool_calls",
          calls: [
            {
              id: "c1",
              name: "ask_user",
              arguments: JSON.stringify({ question: "Which account?" }),
            },
          ],
        }),
    }
    setTimeout(() => controller.abort(), 20)
    const events: AgentEvent[] = []
    for await (const e of runAgent({
      userMessage: "go",
      tools: studioTools,
      llm,
      context: studio,
      signal: controller.signal,
      maxTurns: 1,
    }))
      events.push(e)
    expect(asked).toEqual([{ kind: "question", question: "Which account?" }])
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      result: { error: "aborted" },
    })
    expect(events.at(-1)?.type).toBe("aborted")
  })

  it("drives a scene end to end through the agent (scripted model)", async () => {
    const { studio } = makeStudio()
    const turns: LlmTurn[] = [
      {
        kind: "tool_calls",
        calls: [
          {
            id: "c1",
            name: "save_scene",
            arguments: JSON.stringify({ id: "tour", title: "Tour", yaml: SCENE }),
          },
        ],
      },
      {
        kind: "tool_calls",
        calls: [{ id: "c2", name: "record_scene", arguments: JSON.stringify({ id: "tour" }) }],
      },
      { kind: "text", text: "Your scene is recorded." },
    ]
    const llm: LlmClient = {
      complete: () => Promise.resolve(turns.shift() ?? { kind: "text", text: "(end)" }),
    }
    const events: AgentEvent[] = []
    for await (const e of runAgent({
      userMessage: "Show how to open projects",
      system: systemPrompt(studio),
      tools: studioTools,
      llm,
      context: studio,
    }))
      events.push(e)
    const results = events.flatMap((e) => (e.type === "tool_result" ? [e.result] : []))
    expect(results[0]).toMatch(/^saved/)
    expect(results[1]).toMatch(/^recorded/)
    expect(events.at(-1)?.type).toBe("done")
    await studio.close()
  }, 60_000)

  it("never shows the agent a secret it typed, in a snapshot or an error", async () => {
    const { studio } = makeStudio()
    const run = (step: object) => tool("run_step").run({ scene: "keys", step }, studio, never)
    await run({ id: "go", action: "goto", url: "/projects" })
    await run({
      id: "new",
      action: "click",
      target: { by: "role", role: "button", name: "New project" },
    })
    expect(
      await run({
        id: "key",
        action: "type",
        target: { by: "label", name: "Project name" },
        value: "{{secrets.acme.key}}",
      }),
    ).toMatch(/^ok/)
    const snap = (await tool("snapshot").run({}, studio, never)) as string
    expect(snap).not.toContain("sk-live-4242424242")
    await studio.close()
  }, 60_000)

  it("keeps an existing scene's other fields, and never turns a card into a recording", async () => {
    const { studio } = makeStudio()
    const { saveScene } = await import("@kiframe/project")
    saveScene(studio.project, {
      version: 1,
      id: "tour",
      title: "Old",
      source: { kind: "recording" },
      duration: { mode: "auto" },
      transitionIn: { kind: "fade", ms: 300 },
    })
    expect(
      await tool("save_scene").run({ id: "tour", title: "Tour", yaml: SCENE }, studio, never),
    ).toMatch(/^saved/)
    expect(studio.project.scenes.get("tour")?.scene).toMatchObject({
      title: "Tour",
      transitionIn: { kind: "fade", ms: 300 },
    })
    saveScene(studio.project, {
      version: 1,
      id: "intro",
      title: "Intro",
      source: { kind: "card", template: "title", content: { heading: "Hi" } },
      duration: { mode: "auto" },
    })
    expect(
      await tool("save_scene").run({ id: "intro", title: "Intro", yaml: SCENE }, studio, never),
    ).toMatchObject({ error: expect.stringMatching(/card scene/) as unknown })
    await studio.close()
  }, 60_000)

  it("goes back to the opener when a step closes the popup it started on", async () => {
    const { studio } = makeStudio()
    const run = (step: object) => tool("run_step").run({ scene: "pop", step }, studio, never)
    await run({ id: "go", action: "goto", url: "/opener" })
    expect(
      await run({
        id: "open",
        action: "click",
        target: { by: "role", role: "button", name: "Open popup" },
      }),
    ).toMatch(/url: \/popup-report/)
    // This run starts on the popup: it has no page of its own to return to when it closes.
    expect(
      await run({
        id: "done",
        action: "click",
        target: { by: "role", role: "button", name: "Done" },
      }),
    ).toMatch(/^ok .*url: \/opener/)
    expect(await tool("snapshot").run({}, studio, never)).toMatch(/^url: \/opener/)
    await studio.close()
  }, 60_000)

  it("scrubs every tool's result on its way to the model (a url, a user's answer)", async () => {
    const { studio } = makeStudio(() => Promise.resolve("it's sk-live-4242424242"), {
      knownValues: () => new Set(["sk-live-4242424242"]),
    })
    expect(
      await tool("run_step").run(
        { scene: "s", step: { id: "go", action: "goto", url: "/sk-live-4242424242" } },
        studio,
        never,
      ),
    ).not.toContain("sk-live-4242424242")
    const answer = await tool("ask_user").run({ question: "Which key?" }, studio, never)
    expect(JSON.stringify(answer)).not.toContain("sk-live-4242424242")
    expect(JSON.stringify(answer)).toMatch(/it's/)
    await studio.close()
  }, 60_000)

  it("never overwrites a scene whose scene.json didn't read", async () => {
    const { dir } = makeStudio()
    mkdirSync(join(dir, "scenes", "intro"), { recursive: true })
    writeFileSync(
      join(dir, "scenes", "intro", "scene.json"),
      '{"version": 1, "id": "intro", "sourc',
    )
    const reopened = openProject(dir)
    expect(reopened.problems.some((p) => p.sceneId === "intro" && p.part === "scene")).toBe(true)
    const { studio } = makeStudio(undefined, { project: reopened })
    expect(
      await tool("save_scene").run({ id: "intro", title: "Intro", yaml: SCENE }, studio, never),
    ).toMatchObject({ error: expect.stringMatching(/didn't read/) as unknown })
    await studio.close()
  }, 60_000)

  it("refuses a host scene key that isn't kebab-case", async () => {
    const { studio } = makeStudio(undefined, { sceneKey: (id) => `Host/${id}` })
    expect(
      await tool("run_step").run(
        { scene: "s", step: { id: "a", action: "pause", ms: 1 } },
        studio,
        never,
      ),
    ).toEqual({ error: expect.stringMatching(/kebab-case/) as unknown })
    await studio.close()
  }, 30_000)

  it("scrubs a snapshot before cutting it (a value the cut splits never shows in part)", async () => {
    const value = "sk-live-4242424242"
    const { studio } = makeStudio(undefined, { knownValues: () => new Set([value]) })
    const page = await studio.livePage()
    // The value placed across the cut: SNAPSHOT_MAX falls in its middle.
    const fill = async (n: number) => {
      await page.setContent(`<p>${"x".repeat(n)} ${value} ${"y".repeat(1000)}</p>`)
      return (await page.locator("body").ariaSnapshot()).indexOf(value)
    }
    const at = await fill(SNAPSHOT_MAX)
    expect(await fill(SNAPSHOT_MAX + (SNAPSHOT_MAX - 8 - at))).toBe(SNAPSHOT_MAX - 8)
    const snap = (await tool("snapshot").run({}, studio, never)) as string
    expect(snap).toMatch(/cut: /)
    expect(snap).not.toContain(value.slice(0, 8))
    await studio.close()
  }, 30_000)

  it("replays a scene at the recording's pace before saving (what a person's typing changes, it sees)", async () => {
    // Typed at a person's pace, the suggestions open (a pause after the comma); at once, never.
    const config = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: human } }
`)
    const { studio } = makeStudio(undefined, { config })
    // The project's typing pace (the scene's own cursor pacing set: the pointer goes at once).
    const yaml = `version: 1
overrides: { pacing: { cursor: natural } }
setup: [{ action: goto, url: /slow-suggest }]
steps:
  - { id: find, action: type, target: { by: label, name: Find }, value: "red, green" }
  - { id: closed, action: expect, that: { hidden: { by: css, selector: "#suggest" } }, timeout: 100 }
  - { id: a, action: pause, ms: 1 }
  - { id: b, action: pause, ms: 1 }
  - { id: c, action: pause, ms: 1 }
`
    const saved = await tool("save_scene").run(
      { id: "suggest", title: "Suggest", yaml },
      studio,
      never,
    )
    expect(saved).toMatchObject({
      error: expect.stringMatching(/replay failed: .*closed/) as unknown,
    })
    await studio.close()
  }, 60_000)

  it("finds what a long page has past the snapshot's cut, its refs ready to scroll to", async () => {
    const value = "sk-live-4242424242"
    const { studio } = makeStudio(undefined, { knownValues: () => new Set([value]) })
    const step = (s: object) => tool("run_step").run({ scene: "long", step: s }, studio, never)
    const page = await studio.livePage()
    const rows = Array.from({ length: 600 }, (_, i) => `<p>Season ${i}: matches and goals</p>`)
    await page.setContent(
      `<main>${rows.join("")}<h2>World Cup 2026</h2><p>Key: ${value}</p><p>The final.</p></main>`,
    )
    const whole = (await tool("snapshot").run({}, studio, never)) as string
    expect(whole).toMatch(/cut: .*use `find`/)
    expect(whole).toMatch(/\nview: at the top of the page \(this snapshot covers the whole page/)
    // A region's snapshot: no word of the page's view.
    expect(
      await tool("snapshot").run({ within: { by: "role", role: "main" } }, studio, never),
    ).not.toMatch(/view:/)
    expect(whole).not.toContain("World Cup 2026")
    const found = (await tool("snapshot").run({ find: "world cup" }, studio, never)) as string
    expect(found).toMatch(
      /- main( \[ref=e\d+\])?:\n {2}…\n {2}- heading "World Cup 2026" \[level=2\] \[ref=e\d+\]\n…$/,
    )
    const ref = /heading "World Cup 2026" \[level=2\] \[ref=(e\d+)\]/.exec(found)?.[1]
    expect(await step({ id: "to", action: "scroll", to: { ref } })).toMatch(/^ok/)
    expect(
      await page.getByRole("heading", { name: "World Cup 2026" }).evaluate((h) => {
        const r = h.getBoundingClientRect()
        return r.top >= 0 && r.bottom <= innerHeight
      }),
    ).toBe(true)
    // After the scroll, the snapshot says where the view is (its text still starts at the top).
    expect(await tool("snapshot").run({}, studio, never)).toMatch(
      /\nview: (9\d|100)% down the page, in "World Cup 2026"/,
    )
    // No block holds the phrase as written: the ones holding all its words, said as such.
    expect(await tool("snapshot").run({ find: "goals Season 599" }, studio, never)).toMatch(
      /holds "goals Season 599" as written; these hold all its words:\n[\s\S]*Season 599: matches and goals/,
    )
    // A search runs on the scrubbed snapshot: a secret's value is never told from a miss.
    expect(await tool("snapshot").run({ find: value.slice(0, 10) }, studio, never)).toMatch(
      /nothing in the page mentions/,
    )
    await studio.close()
  }, 30_000)

  it("keeps a tool's error as it was, scrubbed, even one that can't be written (a DOMException)", async () => {
    const { studio } = makeStudio(
      () => Promise.reject(new DOMException("timed out for sk-live-4242424242", "TimeoutError")),
      { knownValues: () => new Set(["sk-live-4242424242"]) },
    )
    const error = await tool("ask_user")
      .run({ question: "Which key?" }, studio, never)
      .catch((e: unknown) => e as Error)
    expect(error).toMatchObject({ name: "TimeoutError" })
    expect((error as Error).message).toMatch(/^timed out for /)
    expect((error as Error).message).not.toContain("sk-live-4242424242")
    await studio.close()
  }, 30_000)

  it("says a preset stopped when a step closed the popup it started on", async () => {
    const { studio } = makeStudio(undefined, {
      config: parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
presets:
  finish:
    steps:
      - { action: click, target: { by: role, role: button, name: Done } }
      - { action: goto, url: /projects }
`),
    })
    const run = (step: object) => tool("run_step").run({ scene: "pop", step }, studio, never)
    await run({ id: "go", action: "goto", url: "/opener" })
    await run({
      id: "open",
      action: "click",
      target: { by: "role", role: "button", name: "Open popup" },
    })
    expect(await run({ preset: "finish" })).toEqual({
      error: expect.stringMatching(/^failed \(page-closed\).*didn't run/) as unknown,
    })
    expect(await tool("snapshot").run({}, studio, never)).toMatch(/^url: \/opener/)
    await studio.close()
  }, 60_000)

  it("runs a teardown action as the teardown's (its approval is that part's)", async () => {
    const { studio, asked } = makeStudio(() => Promise.resolve(true))
    const risky = {
      action: "click",
      target: { by: "role", role: "link", name: "Projects" },
      risky: true,
    }
    expect(
      await tool("run_step").run({ scene: "s", step: risky, part: "teardown" }, studio, never),
    ).toMatch(/^ok/)
    expect(asked[0]).toMatchObject({ kind: "approve-risky", step: "teardown[0]" })
    await studio.close()
  }, 30_000)

  it("never encodes a recording that stops (the take store drops its video)", async () => {
    // What the store is given to settle: a failed take with or without its video.
    let encoded: boolean | undefined
    class Watching extends TakeStore {
      override settle(dir: string) {
        encoded = existsSync(join(`${dir}.failed`, "frames.webm"))
        return super.settle(dir)
      }
    }
    const { studio } = makeStudio(undefined, {
      takes: new Watching(mkdtempSync(join(tmpdir(), "kiframe-data-"))),
    })
    const long = `version: 1
setup: [{ action: goto, url: / }]
steps:
${["a", "b", "c", "d", "e"].map((id) => `  - { id: ${id}, action: pause, ms: 1500 }`).join("\n")}
`
    expect(
      await tool("save_scene").run({ id: "long", title: "Long", yaml: long }, studio, never),
    ).toMatch(/^saved/)
    const stop = new AbortController()
    const recording = tool("record_scene").run({ id: "long" }, studio, stop.signal)
    await new Promise((r) => setTimeout(r, 2500))
    stop.abort()
    await recording.catch(() => undefined)
    expect(encoded).toBe(false)
    await studio.close()
  }, 60_000)

  it("records only a recording scene", async () => {
    let tidied = 0
    const { studio } = makeStudio(undefined, { afterRecord: () => (tidied += 1) })
    const { saveScene } = await import("@kiframe/project")
    const { parseScenarioYaml } = await import("@kiframe/schema")
    saveScene(
      studio.project,
      {
        version: 1,
        id: "intro",
        title: "Intro",
        source: { kind: "card", template: "title", content: { heading: "Hi" } },
        duration: { mode: "auto" },
      },
      { scenario: parseScenarioYaml(SCENE) },
    )
    expect(await tool("record_scene").run({ id: "intro" }, studio, never)).toEqual({
      error: expect.stringMatching(/card scene: only recordings/) as unknown,
    })
    expect(tidied).toBe(0)
    await studio.close()
  }, 30_000)

  it("never shows a known value in the system prompt's app url", () => {
    const { studio } = makeStudio(undefined, { knownValues: () => new Set(["127.0.0.1"]) })
    expect(systemPrompt(studio)).not.toContain("127.0.0.1")
  })

  it("stops a tool's dialog when the studio closes", async () => {
    const { studio } = makeStudio(
      (_r, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason as Error))
        }),
    )
    const pending = tool("ask_user").run({ question: "Which?" }, studio, never)
    await studio.close()
    await expect(pending).rejects.toThrow()
  })

  it("aborts a stopped step's call, and refuses an on-camera step without id", async () => {
    const { studio } = makeStudio()
    const stopped = new AbortController()
    stopped.abort()
    await expect(
      tool("run_step").run(
        { scene: "s", step: { id: "a", action: "pause", ms: 1 } },
        studio,
        stopped.signal,
      ),
    ).rejects.toThrow(/stopped/)
    expect(
      await tool("run_step").run({ scene: "s", step: { action: "pause", ms: 1 } }, studio, never),
    ).toEqual({ error: expect.stringMatching(/needs an id/) as unknown })
    await studio.close()
  }, 30_000)

  it("opens one live page for callers at once", async () => {
    const { studio } = makeStudio()
    const [a, b] = await Promise.all([studio.livePage(), studio.livePage()])
    expect(a).toBe(b)
    expect(browser.contexts().filter((c) => c.pages().includes(a))).toHaveLength(1)
    const before = browser.contexts().length
    await studio.close()
    expect(browser.contexts().length).toBe(before - 1)
  }, 30_000)

  it("shows an action's forms when a step is refused (never a guess at its fields)", async () => {
    const { studio } = makeStudio()
    const refused = (await tool("run_step").run(
      {
        scene: "s",
        step: {
          id: "draw",
          action: "drag",
          target: { by: "css", selector: "canvas" },
          to: { x: 10 },
        },
      },
      studio,
      never,
    )) as { error: string }
    expect(refused.error).toMatch(/^invalid step: /)
    expect(refused.error).toMatch(/drag: press on the target/)
    expect(refused.error).toMatch(/to: \{ dx: 120, dy: 0 \}/)
    expect(refused.error).toMatch(/at: \{ x: 0\.6, y: 0\.7 \}/)
    const unknown = (await tool("run_step").run(
      { scene: "s", step: { id: "d", action: "draw", target: { by: "css", selector: "canvas" } } },
      studio,
      never,
    )) as { error: string }
    expect(unknown.error).toMatch(/actions: goto, click, hover/)
    await studio.close()
  }, 30_000)

  it("says when the page is on another site than the app's", async () => {
    const { studio } = makeStudio()
    const page = await studio.livePage()
    // The same server under another host name: another site.
    await page.goto(`${server.url.replace("127.0.0.1", "localhost")}/projects?token=abc`)
    const snap = (await tool("snapshot").run({}, studio, never)) as string
    expect(snap).toMatch(
      /^url: \/projects \(on localhost:\d+: NOT the app's site, 127\.0\.0\.1:\d+\)/,
    )
    expect(snap).not.toContain("token")
    await page.goto(`${server.url}/projects`)
    expect(await tool("snapshot").run({}, studio, never)).toMatch(/^url: \/projects\n/)
    // The app's address redirected to www.: the app's own page (decided by the user), its
    // secrets typed on the app's exact origin only (said).
    expect(whereOf("https://www.app.example/x", "https://app.example")).toBe(
      "/x (on https://www.app.example, the app's site: secrets are typed on https://app.example only)",
    )
    expect(whereOf("https://app.example/x", "https://app.example")).toBe("/x")
    expect(whereOf("https://github.com/x", "https://app.example")).toMatch(/NOT the app's site/)
    await studio.close()
  }, 30_000)

  it("replays a scene at the size of the app it starts in (B2)", async () => {
    const docs = new URL(server.url)
    docs.hostname = "localhost"
    const config = parseProjectYaml(`version: 2
apps:
  app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } }
  docs: { kind: web, url: "${docs.origin}", viewport: { width: 640, height: 480 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const { studio } = makeStudio(undefined, { config })
    const scenario = parseScenarioYaml(`version: 1
app: docs
setup: [{ action: goto, url: /size }]
steps: [{ id: w, action: expect, that: { text: "w=640" } }]
`)
    expect(await studio.replay(scenario, "sized", new AbortController().signal)).toBe("ok")
    await studio.close()
  }, 30_000)

  it("says a replay of a scene naming an app the project doesn't list failed (never throws)", async () => {
    const { studio } = makeStudio()
    const scenario = parseScenarioYaml(`version: 1
app: docs
steps: [{ id: a, action: pause, ms: 1 }]
`)
    expect(await studio.replay(scenario, "gone", new AbortController().signal)).toMatch(
      /^replay failed: .*"docs" isn't one of the project's apps/,
    )
    await studio.close()
  }, 30_000)

  it("says which of the project's apps a page is on (B2)", () => {
    const apps = { app: { url: "https://app.example" }, docs: { url: "https://docs.example" } }
    expect(whereOf("https://app.example/x", apps)).toBe("/x")
    expect(whereOf("https://docs.example/install", apps)).toBe("docs: /install")
    expect(whereOf("https://www.docs.example/i", apps)).toBe(
      "docs: /i (on https://www.docs.example, the app's site: secrets are typed on https://docs.example only)",
    )
    expect(siteOf("https://docs.example/i", apps)).toBe("app")
    expect(siteOf("https://login.example/", apps)).toBe("other")
    expect(whereOf("https://login.example/sso", apps)).toBe(
      "/sso (on login.example: NOT one of the project's apps, app.example, docs.example)",
    )
  })

  it("acts on an element pointed at by its snapshot ref, and says the step as written", async () => {
    const { studio } = makeStudio()
    const refOf = (snap: string, line: RegExp) => {
      const ref = new RegExp(`${line.source}.*\\[ref=((?:f\\d+)?e\\d+)\\]`).exec(snap)?.[1]
      if (ref === undefined) throw new Error(`no ${String(line)} in the snapshot:\n${snap}`)
      return ref
    }
    const link = refOf((await tool("snapshot").run({}, studio, never)) as string, /link "Projects"/)
    const opened = (await tool("run_step").run(
      { scene: "tour", step: { id: "open", action: "click", target: { ref: link } } },
      studio,
      never,
    )) as string
    expect(opened.split("\n")).toEqual([
      expect.stringMatching(/^ok\. url: \/projects/) as unknown,
      "as written: { id: open, action: click, target: { by: role, role: link, name: Projects, exact: true } }",
    ])
    // The old document's ref (numbering starts over in a new one): refused, whatever it'd name now.
    expect(
      await tool("run_step").run(
        { scene: "tour", step: { id: "again", action: "click", target: { ref: link } } },
        studio,
        never,
      ),
    ).toEqual({
      error: expect.stringMatching(/^ref (f\d+)?e\d+: the page loaded a new document/) as unknown,
    })
    // Look-alikes: refused before anything runs (never a place among them, which a changed page
    // turns into another element).
    const snap = (await tool("snapshot").run({}, studio, never)) as string
    const saves = [...snap.matchAll(/button "Save" \[ref=((?:f\d+)?e\d+)\]/g)].map((m) => m[1])
    expect(saves).toHaveLength(2)
    const batch = await tool("run_steps").run(
      {
        scene: "tour",
        steps: [
          { id: "first", action: "hover", target: { ref: saves[0] } },
          { id: "second", action: "hover", target: { ref: saves[1] } },
        ],
      },
      studio,
      never,
    )
    expect(batch).toEqual({
      error: expect.stringMatching(
        /^step 1 ref \S+: several elements look just like it/,
      ) as unknown,
    })
    // Not a ref of the last snapshot, or inside a frame: nothing runs, and why.
    const run = (ref: string) =>
      tool("run_steps").run(
        {
          scene: "tour",
          steps: [
            { id: "a", action: "pause", ms: 1 },
            { id: "b", action: "click", target: { ref } },
          ],
        },
        studio,
        never,
      )
    expect(await run("e99999")).toEqual({
      error: expect.stringMatching(
        /^nothing ran: ref e99999: not a ref of the last snapshot/,
      ) as unknown,
    })
    await tool("run_step").run(
      { scene: "tour", step: { id: "framed", action: "goto", url: "/framed" } },
      studio,
      never,
    )
    const framed = (await tool("snapshot").run({}, studio, never)) as string
    expect(await run(refOf(framed, /button "Inside"/))).toEqual({
      // Checked before anything runs (the step before it never ran).
      error: expect.stringMatching(/^nothing ran: ref \S+: it's inside a frame/) as unknown,
    })
    expect(await run(refOf(framed, /button "Outside"/))).toMatch(/^2 steps ok/)
    // A ref never reaches a scene's YAML.
    const saved = await tool("save_scene").run(
      {
        id: "tour",
        title: "Tour",
        yaml: SCENE.replace("{ by: role, role: link, name: Projects }", `{ ref: ${link} }`),
      },
      studio,
      never,
    )
    expect(saved).toEqual({
      error: expect.stringMatching(/a ref \((f\d+)?e\d+\) is only for run_step/) as unknown,
    })
    await studio.close()
  }, 60_000)

  it("writes a ref's locator where the step takes it, and only for a step that worked", async () => {
    const { studio } = makeStudio()
    const step = (s: object) => tool("run_step").run({ scene: "tour", step: s }, studio, never)
    await step({ id: "go", action: "goto", url: "/quoted-names" })
    const snap = (await tool("snapshot").run({}, studio, never)) as string
    // A name the snapshot quotes (": "): its ref read all the same; page text saying a ref isn't one.
    const status = /'button "Status: Active" \[ref=([a-z0-9]+)\]'/.exec(snap)?.[1]
    expect(status, snap).toBeDefined()
    expect(await step({ id: "s", action: "hover", target: { ref: status } })).toContain(
      'as written: { id: s, action: hover, target: { by: role, role: button, name: "Status: Active", exact: true } }',
    )
    // A ref with anything beside it: refused, said why.
    expect(await step({ id: "s", action: "hover", target: { ref: status, nth: 0 } })).toEqual({
      error: expect.stringMatching(/a ref goes alone .*without nth/) as unknown,
    })
    // A step that fails says no "as written" (its locator isn't confirmed).
    const failedStep = await step({
      id: "t",
      action: "expect",
      that: { hidden: { ref: status } },
      timeout: 300,
    })
    expect(failedStep).toEqual({ error: expect.not.stringContaining("as written") as unknown })
    // Look-alikes, wherever the ref is (a condition's locator too): refused.
    await step({ id: "p", action: "goto", url: "/projects" })
    const saves = [
      ...((await tool("snapshot").run({}, studio, never)) as string).matchAll(
        /button "Save" \[ref=([a-z0-9]+)\]/g,
      ),
    ].map((m) => m[1])
    expect(await step({ id: "v", action: "expect", that: { visible: { ref: saves[1] } } })).toEqual(
      {
        error: expect.stringMatching(/several elements look just like it/) as unknown,
      },
    )
    await studio.close()
  }, 60_000)

  it("uses a ref only on the page its snapshot was of (a popup's refs never reach its opener)", async () => {
    const { studio } = makeStudio()
    const step = (s: object) => tool("run_step").run({ scene: "pop", step: s }, studio, never)
    const refOf = (snap: string, line: RegExp) => {
      const ref = new RegExp(`${line.source}.*\\[ref=([a-z0-9]+)\\]`).exec(snap)?.[1]
      if (ref === undefined) throw new Error(`no ${String(line)} in the snapshot:\n${snap}`)
      return ref
    }
    await step({ id: "go", action: "goto", url: "/opener" })
    const opener = (await tool("snapshot").run({}, studio, never)) as string
    const openPopup = refOf(opener, /button "Open popup"/)
    // Steps sent as text, refs and all.
    expect(
      await tool("run_steps").run(
        { scene: "pop", steps: [`{ id: open, action: click, target: { ref: ${openPopup} } }`] },
        studio,
        never,
      ),
    ).toMatch(/^1 step ok\n1\. ok\. url: \/popup-report/)
    // The popup is live: the opener's snapshot isn't this page's.
    expect(await step({ id: "again", action: "click", target: { ref: openPopup } })).toEqual({
      error: expect.stringMatching(/the last snapshot was of another page/) as unknown,
    })
    const popup = (await tool("snapshot").run({}, studio, never)) as string
    const done = refOf(popup, /button "Done"/)
    await step({ id: "close", action: "click", target: { ref: done } })
    // Back on the opener: the popup's refs (numbered like the opener's) never name its elements.
    expect(await step({ id: "late", action: "click", target: { ref: done } })).toEqual({
      error: expect.stringMatching(/the last snapshot was of another page/) as unknown,
    })
    // A YAML alias inside what it names: refused, never a crash.
    expect(await step("&a { id: x, action: click, target: *a }" as unknown as object)).toEqual({
      error: "invalid step: a YAML alias refers to itself (or it nests too deep)",
    })
    await studio.close()
  }, 60_000)

  it("checks a ref's element in Playwright's own reading: still there, the same, in the same document", async () => {
    const { studio } = makeStudio()
    const step = (s: object) => tool("run_step").run({ scene: "rows", step: s }, studio, never)
    const refOf = (snap: string, line: RegExp) => {
      const ref = new RegExp(`${line.source}.*?\\[ref=([a-z0-9]+)\\]`).exec(snap)?.[1]
      if (ref === undefined) throw new Error(`no ${String(line)} in the snapshot:\n${snap}`)
      return ref
    }
    await step({ id: "go", action: "goto", url: "/rows" })
    const snap = (await tool("snapshot").run({}, studio, never)) as string
    const [row, email, done, path, reorder] = [
      refOf(snap, /listitem/),
      refOf(snap, /textbox "Email"/),
      // Its text drawn by CSS ("* ") is in the snapshot's reading.
      refOf(snap, /listitem(?= \[ref=[a-z0-9]+\]: "\* Done")/),
      refOf(snap, /link \/x\//),
      refOf(snap, /button "Reorder"/),
    ]
    // A filled field (its snapshot text is its value), text drawn by CSS, a name written unquoted.
    expect(
      await step({ id: "e", action: "type", target: { ref: email }, value: "z@z.z", clear: true }),
    ).toContain("target: { by: role, role: textbox, name: Email, exact: true }")
    expect(await step({ id: "d", action: "hover", target: { ref: done } })).toMatch(/^ok/)
    expect(await step({ id: "p", action: "hover", target: { ref: path } })).toContain(
      "target: { by: role, role: link, name: /x/, exact: true }",
    )
    // The field is still the same field once typed into (its value changed).
    expect(await step({ id: "e2", action: "hover", target: { ref: email } })).toMatch(/^ok/)
    // A row a step rewrote ("Buy milk" now "Buy eggs": same node, same ref): another element.
    expect(
      await tool("run_steps").run(
        {
          scene: "rows",
          steps: [
            { id: "r", action: "click", target: { ref: reorder } },
            { id: "row", action: "hover", target: { ref: row } },
          ],
        },
        studio,
        never,
      ),
    ).toEqual({
      error: expect.stringMatching(/^step 2 ref \S+: it changed since the snapshot/) as unknown,
    })
    // Look-alikes (each row's checkbox and "Delete"): told apart by their row, never by a place
    // among them (a changed list turns a place into another row).
    const todo = (await tool("snapshot").run({}, studio, never)) as string
    expect(
      await step({ id: "x", action: "hover", target: { ref: refOf(todo, /checkbox/) } }),
    ).toContain("target: { by: role, role: checkbox, in: { role: listitem, has: Pay rent } }")
    expect(
      await step({ id: "y", action: "hover", target: { ref: refOf(todo, /button "Delete"/) } }),
    ).toContain(
      "target: { by: role, role: button, name: Delete, exact: true, in: { role: listitem, has: Pay rent } }",
    )
    // Where a step takes a locator alone (a condition), a look-alike's row can't be said: refused.
    expect(
      await step({
        id: "z",
        action: "expect",
        that: { visible: { ref: refOf(todo, /button "Delete"/) } },
      }),
    ).toEqual({ error: expect.stringMatching(/here a locator can't name its row/) as unknown })
    // A reload: a new document, its refs numbered again from e1 (whatever the old ref names now).
    await step({ id: "again", action: "goto", url: "/rows" })
    expect(await step({ id: "d2", action: "hover", target: { ref: done } })).toEqual({
      error: expect.stringMatching(/the page loaded a new document/) as unknown,
    })
    await studio.close()
  }, 60_000)

  it("runs several steps in one call, stopping at the first that fails", async () => {
    const { studio } = makeStudio()
    const result = (await tool("run_steps").run(
      {
        scene: "tour",
        steps: [
          { id: "go", action: "goto", url: "/" },
          { id: "open", action: "click", target: { by: "role", role: "link", name: "Projects" } },
          {
            id: "nope",
            action: "click",
            target: { by: "role", role: "button", name: "Nothing here" },
          },
          { id: "never", action: "pause", ms: 1 },
        ],
      },
      studio,
      never,
    )) as { error: string }
    const lines = result.error.split("\n")
    expect(lines.shift()).toMatch(/^step 3 failed \(target-not-found\)/)
    expect(lines[0]).toMatch(/^1\. ok/)
    expect(lines[1]).toMatch(/^2\. ok\. url: \/projects/)
    expect(lines[2]).toMatch(/^3\. failed \(target-not-found\)/)
    expect(lines[3]).toBe("stopped there: the 1 after it didn't run")
    // A list sent as text (a model's habit) is read as the list it says.
    const asText = (await tool("run_steps").run(
      { scene: "tour", steps: "[{ id: go, action: goto, url: / }]" },
      studio,
      never,
    )) as string
    expect(asText.split("\n")).toEqual(["1 step ok", expect.stringMatching(/^1\. ok/) as unknown])
    // A step that leaves the app's site stops the rest.
    const page = await studio.livePage()
    await page.goto(`${server.url.replace("127.0.0.1", "localhost")}/`)
    const offSite = (await tool("run_steps").run(
      {
        scene: "tour",
        steps: [
          { id: "look", action: "pause", ms: 1 },
          { id: "more", action: "pause", ms: 1 },
        ],
      },
      studio,
      never,
    )) as string
    expect(offSite.split("\n")).toEqual([
      "step 1 left the app's site",
      expect.stringMatching(/^1\. ok\. url: \/ \(on localhost/) as unknown,
      "stopped there: the 1 after it didn't run",
    ])
    const app = "https://app.example"
    expect(siteOf("https://app.example/x", app)).toBe("app")
    // The app's address redirecting (www., either way; http to https) is the app.
    expect(siteOf("https://www.app.example/x", app)).toBe("app")
    expect(siteOf("https://app.example/x", "https://www.app.example")).toBe("app")
    expect(siteOf("https://app.example/x", "http://app.example")).toBe("app")
    expect(siteOf("https://login.app.example/x", app)).toBe("other")
    expect(siteOf("http://app.example/x", app)).toBe("other")
    expect(siteOf("blob:https://app.example/1234", app)).toBe("app")
    expect(siteOf("about:blank", app)).toBe("app")
    expect(siteOf("data:text/html,hi", app)).toBe("other")
    expect(siteOf("https://github.com/x", app)).toBe("other")
    expect(siteOf("chrome-error://chromewebdata/", app)).toBe("unloaded")
    expect(whereOf("data:text/html,secret-content", app)).toBe("(a data page: not the app)")
    expect(whereOf("about:blank", app)).toBe("(a blank page)")
    expect(whereOf("chrome-error://chromewebdata/", "https://app.example")).toBe(
      "(the page failed to load: try again)",
    )
    await studio.close()
  }, 60_000)
})
