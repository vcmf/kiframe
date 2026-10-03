import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentEvent, type LlmClient, type LlmTurn, runAgent } from "@kiframe/agent"
import { createProject, openProject, TakeStore } from "@kiframe/project"
import { parseProjectYaml } from "@kiframe/schema"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFixtureServer } from "../../runtime/test/fixture-server.ts"
import {
  SNAPSHOT_MAX,
  Studio,
  studioTools,
  systemPrompt,
  type UserRequest,
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
  const config = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } }
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
    ).toMatch(/failed \(/)
    await studio.close()
  }, 30_000)

  it("saves a scene only once its replay passes, then records it with its composition", async () => {
    const { studio, dir } = makeStudio()
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
    expect(await tool("record_scene").run({ id: "tour" }, studio, never)).toMatch(/^recorded/)
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
    ).toMatch(/kebab-case/)
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
      config: parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } }
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
    expect(await run({ preset: "finish" })).toMatch(/^failed \(page-closed\).*didn't run/)
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

  it("records only a recording scene", async () => {
    const { studio } = makeStudio()
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
    expect(await tool("record_scene").run({ id: "intro" }, studio, never)).toMatch(
      /card scene: only recordings/,
    )
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
    ).toMatch(/needs an id/)
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
    )) as string
    expect(refused).toMatch(/^invalid step: /)
    expect(refused).toMatch(/drag: press on the target/)
    expect(refused).toMatch(/to: \{ dx: 120, dy: 0 \}/)
    expect(refused).toMatch(/at: \{ x: 0\.6, y: 0\.7 \}/)
    const unknown = (await tool("run_step").run(
      { scene: "s", step: { id: "d", action: "draw", target: { by: "css", selector: "canvas" } } },
      studio,
      never,
    )) as string
    expect(unknown).toMatch(/actions: goto, click, hover/)
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
    expect(whereOf("https://www.app.example/x", "https://app.example")).toBe("/x")
    expect(whereOf("https://app.example/x", "https://www.app.example")).toBe("/x")
    expect(whereOf("https://github.com/x", "https://app.example")).toMatch(/NOT the app's site/)
    await studio.close()
  }, 30_000)

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
    )) as string
    const lines = result.split("\n")
    expect(lines[0]).toMatch(/^1\. ok/)
    expect(lines[1]).toMatch(/^2\. ok\. url: \/projects/)
    expect(lines[2]).toMatch(/^3\. failed \(target-not-found\)/)
    expect(lines[3]).toBe("stopped there: the 1 after it didn't run")
    await studio.close()
  }, 60_000)
})
