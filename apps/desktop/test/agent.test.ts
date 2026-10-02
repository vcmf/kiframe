import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmClient, LlmMessage, LlmTurn } from "@kiframe/agent"
import { createProject, TakeStore } from "@kiframe/project"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFixtureServer } from "../../../packages/runtime/test/fixture-server.ts"
import type { ChatItem, LiveFrame } from "../src/shared/ipc.ts"
import { AgentHost } from "../src/main/agent.ts"

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

const call = (name: string, args: object, id = `c-${name}`): LlmTurn => ({
  kind: "tool_calls",
  calls: [{ id, name, arguments: JSON.stringify(args) }],
})

/** A scripted model: each call answers the next turn; it records what it was sent. */
function script(turns: LlmTurn[]) {
  const seen: LlmMessage[][] = []
  const llm: LlmClient = {
    complete: (messages) => {
      seen.push(messages)
      return Promise.resolve(turns.shift() ?? { kind: "text", text: "(done)" })
    },
  }
  return { llm, seen }
}

function host(model: LlmClient | (() => Promise<LlmClient>)) {
  const llm = typeof model === "function" ? model : () => Promise.resolve(model)
  const dir = join(mkdtempSync(join(tmpdir(), "kiframe-agent-")), "demo.kiframe")
  const project = createProject(dir, {
    id: "p1",
    name: "Demo",
    url: server.url,
    viewport: { width: 800, height: 600 },
  })
  const items = new Map<string, ChatItem>()
  const sends: ChatItem[] = []
  const order: string[] = []
  const running: boolean[] = []
  const frames: LiveFrame[] = []
  let changed = 0
  const agent = new AgentHost({
    project,
    scope: "folder-0123456789abcdef",
    sceneKey: (id) => `scene-${id}`,
    takes: new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-"))),
    browser: () => Promise.resolve(browser),
    llm,
    model: "test/model",
    item: (item) => {
      sends.push(item)
      if (!items.has(item.id)) order.push(item.id)
      items.set(item.id, item)
    },
    running: (r) => running.push(r),
    frame: (f) => frames.push(f),
    projectChanged: () => {
      changed += 1
    },
  })
  const shown = () => order.map((id) => items.get(id)!)
  const until = async (check: () => boolean, ms = 20_000) => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(shown())}`)
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  return { agent, shown, running, frames, until, sends, changed: () => changed }
}

describe("the agent in the app", () => {
  it("runs a message through the tools, shows each step, and carries the chat to the next run", async () => {
    const { llm, seen } = script([
      call("list_scenes", {}),
      { kind: "text", text: "The project has no scenes yet." },
    ])
    const { agent, shown, running, until, sends } = host(llm)
    expect(agent.send("what's in the project?")).toBeNull()
    await until(() => running.at(-1) === false)
    expect(shown()).toMatchObject([
      { kind: "user", text: "what's in the project?" },
      { kind: "tool", name: "list_scenes", status: "ok" },
      { kind: "assistant", text: "The project has no scenes yet." },
      { kind: "end", outcome: "done" },
    ])
    expect(running).toEqual([true, false])
    // A one-chunk answer is sent once (no repeat from the text timer).
    await new Promise((r) => setTimeout(r, 150))
    expect(sends.filter((i) => i.kind === "assistant")).toHaveLength(1)
    // The next run's model sees this one's turns.
    expect(agent.send("thanks")).toBeNull()
    await until(() => running.length === 4)
    const last = seen.at(-1)!
    expect(last.some((m) => m.role === "user" && m.content === "what's in the project?")).toBe(true)
    expect(
      last.some((m) => m.role === "assistant" && m.content === "The project has no scenes yet."),
    ).toBe(true)
    await agent.close()
  }, 60_000)

  it("asks before a risky step, in the chat, and runs it once approved; the live app is shown", async () => {
    const risky = {
      scene: "tour",
      step: {
        id: "open",
        action: "click",
        target: { by: "role", role: "link", name: "Projects" },
        risky: true,
      },
    }
    const { llm } = script([call("run_step", risky), { kind: "text", text: "Opened." }])
    const { agent, shown, running, frames, until } = host(llm)
    agent.send("open projects")
    await until(() => shown().some((i) => i.kind === "request" && i.state === "open"))
    const request = shown().find((i) => i.kind === "request")!
    expect(request).toMatchObject({
      request: { kind: "approve-risky", scene: "tour", step: "open", action: "click" },
    })
    agent.answer(request.id, "yes") // the wrong kind of answer is ignored
    expect(agent.state().running).toBe(true)
    agent.answer(request.id, true)
    await until(() => running.at(-1) === false)
    expect(shown()).toMatchObject([
      { kind: "user" },
      { kind: "tool", name: "run_step", detail: "click Projects" },
      { kind: "request", state: "answered", answer: true },
      { kind: "assistant", text: "Opened." },
      { kind: "end", outcome: "done" },
    ])
    expect(shown()[1]).toMatchObject({
      status: "ok",
      result: expect.stringMatching(/^ok\. url: \/projects/) as unknown,
    })
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.at(-1)?.jpeg.length).toBeGreaterThan(100)
    await agent.close()
  }, 60_000)

  it("stops at Stop: the open request closes, nothing more runs, and a new run can start", async () => {
    const risky = {
      scene: "tour",
      step: {
        id: "open",
        action: "click",
        target: { by: "role", role: "link", name: "Projects" },
        risky: true,
      },
    }
    const { llm } = script([call("run_step", risky), { kind: "text", text: "never said" }])
    const { agent, shown, running, until } = host(llm)
    agent.send("open projects")
    await until(() => shown().some((i) => i.kind === "request" && i.state === "open"))
    expect(agent.send("another")).toMatch(/still working/)
    agent.stop()
    await until(() => running.at(-1) === false)
    expect(shown()).toMatchObject([
      { kind: "user" },
      { kind: "tool", status: "stopped" },
      { kind: "request", state: "closed" },
      { kind: "end", outcome: "stopped" },
    ])
    expect(shown().some((i) => i.kind === "assistant")).toBe(false)
    expect(agent.send("again")).toBeNull()
    await until(() => running.length === 4)
    await agent.close()
    expect(agent.send("after close")).toMatch(/closed/)
  }, 60_000)

  it("refreshes the project after a tool saves a scene", async () => {
    const yaml = `version: 1
setup: [{ action: goto, url: / }]
steps:
  - { id: look, action: pause, ms: 20 }
  - { id: open, action: click, target: { by: role, role: link, name: Projects }, caption: "Open your projects" }
  - { id: seen, action: expect, that: { url: /projects } }
  - { id: heading, action: expect, that: { visible: { by: role, role: heading, name: Projects } } }
  - { id: beat, action: pause, ms: 20 }
`
    const { llm } = script([
      call("save_scene", { id: "tour", title: "Tour", yaml }),
      { kind: "text", text: "Saved." },
    ])
    const { agent, shown, running, until, changed } = host(llm)
    agent.send("save it")
    await until(() => running.at(-1) === false, 40_000)
    expect(shown()[1]).toMatchObject({ kind: "tool", name: "save_scene", status: "ok" })
    expect(changed()).toBe(1)
    await agent.close()
  }, 60_000)

  it("says why a run couldn't start (no key to make the model), and a model's failure", async () => {
    const noKey = host(() => Promise.reject(new Error("no OpenRouter key: add one first")))
    expect(noKey.agent.send("hi")).toBeNull()
    await noKey.until(() => noKey.running.at(-1) === false)
    expect(noKey.shown().at(-1)).toMatchObject({
      kind: "end",
      outcome: "error",
      message: "no OpenRouter key: add one first",
    })
    await noKey.agent.close()
    const failing = host({ complete: () => Promise.reject(new Error("rate limited")) })
    failing.agent.send("hi")
    await failing.until(() => failing.running.at(-1) === false)
    expect(failing.shown().at(-1)).toMatchObject({
      kind: "end",
      outcome: "error",
      message: "rate limited",
    })
    await failing.agent.close()
  }, 60_000)
})
