import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentEvent, type LlmClient, type LlmTurn, runAgent } from "@kiframe/agent"
import { createProject, openProject, TakeStore } from "@kiframe/project"
import { parseProjectYaml } from "@kiframe/schema"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFixtureServer } from "../../runtime/test/fixture-server.ts"
import { Studio, studioTools, systemPrompt, type UserRequest } from "../src/index.ts"

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
    config,
    takes: new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-"))),
    browser,
    requestUser: (request, signal) => {
      asked.push(request)
      return answer(request, signal)
    },
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
})
