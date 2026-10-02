import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LlmClient, LlmMessage, LlmTurn } from "@kiframe/agent"
import { createProject, TakeStore } from "@kiframe/project"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFixtureServer } from "../../../packages/runtime/test/fixture-server.ts"
import type { ChatItem, LiveFrame } from "../src/shared/ipc.ts"
import { AgentHost, stepLabel } from "../src/main/agent.ts"
import { Secrets } from "../src/main/secrets.ts"
import { memoryBackend } from "@kiframe/vault"

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

function host(
  model: LlmClient | (() => Promise<LlmClient>),
  launch: () => Promise<Browser> = () => Promise.resolve(browser),
  failShowing?: () => void,
  secrets?: Secrets | (() => Secrets | undefined),
) {
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
    browser: launch,
    llm,
    model: "test/model",
    ...(secrets !== undefined && {
      secrets: typeof secrets === "function" ? secrets : () => secrets,
    }),
    item: (item) => {
      failShowing?.()
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
    // The run is over for the user first; the live view's last frame comes right after.
    await until(() => frames.length > 0)
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

  it("works on in a new browser when the last one died (crashed, killed)", async () => {
    let current = await chromium.launch()
    const { llm } = script([
      call("snapshot", {}),
      { kind: "text", text: "one" },
      call("snapshot", {}),
    ])
    const made = host(llm, () => Promise.resolve(current))
    made.agent.send("look")
    await made.until(() => made.running.at(-1) === false)
    await current.close()
    current = await chromium.launch()
    made.agent.send("look again")
    await made.until(() => made.running.length === 4)
    const snapshots = made.shown().filter((i) => i.kind === "tool")
    expect(snapshots.map((s) => s.kind === "tool" && s.status)).toEqual(["ok", "ok"])
    await made.agent.close()
    await current.close()
  }, 60_000)

  it("keeps a run's turns in the history even when showing an event fails", async () => {
    const { llm, seen } = script([call("list_scenes", {}), { kind: "text", text: "None." }])
    const made = host(llm, undefined, () => {
      throw new Error("the window is gone")
    })
    made.agent.send("what's there?")
    await made.until(() => made.running.at(-1) === false)
    made.agent.send("and now?")
    await made.until(() => made.running.length === 4)
    expect(seen.at(-1)?.some((m) => m.role === "assistant" && m.content === "None.")).toBe(true)
    await made.agent.close()
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

  it("keeps a message whose run couldn't start, for the next run's model", async () => {
    let fail = true
    const { llm, seen } = script([{ kind: "text", text: "On it." }])
    const made = host(() =>
      fail ? Promise.reject(new Error("no OpenRouter key")) : Promise.resolve(llm),
    )
    made.agent.send("film the signup flow")
    await made.until(() => made.running.at(-1) === false)
    fail = false
    made.agent.send("go ahead")
    await made.until(() => made.running.length === 4)
    expect(seen[0]?.some((m) => m.role === "user" && m.content === "film the signup flow")).toBe(
      true,
    )
    await made.agent.close()
  }, 60_000)

  it("asks before typing a secret, from the page itself; never shows the agent or the chat its value", async () => {
    const secrets = new Secrets(
      join(mkdtempSync(join(tmpdir(), "kiframe-vault-")), "vault.json"),
      memoryBackend(),
    )
    await secrets.add(
      { name: "acme.password", kind: "password", value: "hunter2-secret" },
      new URL(server.url).origin,
    )
    const typing = (id: string) => [
      call(
        "run_step",
        { scene: "login", step: { id: "go", action: "goto", url: "/login-form" } },
        `${id}-go`,
      ),
      call(
        "run_step",
        {
          scene: "login",
          step: {
            id: "pw",
            action: "type",
            target: { by: "label", name: "Password input" },
            value: "{{secrets.acme.password}}",
          },
        },
        `${id}-pw`,
      ),
    ]
    const { llm, seen } = script([
      ...typing("a"),
      { kind: "text", text: "Typed." },
      ...typing("b"),
      { kind: "text", text: "Again." },
    ])
    const made = host(llm, undefined, undefined, secrets)
    made.agent.send("sign in")
    await made.until(() => made.shown().some((i) => i.kind === "request" && i.state === "open"))
    const asked = made.shown().find((i) => i.kind === "request")!
    expect(asked).toMatchObject({
      request: {
        kind: "approve-secret",
        secret: "acme.password",
        element: { tag: "input", type: "password", label: "Password input" },
        origin: new URL(server.url).origin,
        path: "/login-form",
        step: "pw, in the steps of scene login",
      },
    })
    if (asked.kind !== "request" || asked.request.kind !== "approve-secret")
      throw new Error("no approval")
    expect(asked.request.shot?.png.length).toBeGreaterThan(100)
    expect(asked.request.box?.width).toBeGreaterThan(0)
    made.agent.answer(asked.id, true)
    await made.until(() => made.running.at(-1) === false)
    expect(
      made
        .shown()
        .filter((i) => i.kind === "tool")
        .map((t) => t.kind === "tool" && t.status),
    ).toEqual(["ok", "ok"])
    // Answered: the shot goes (it would sit in the chat).
    const settled = made.shown().find((i) => i.id === asked.id)
    expect(
      settled?.kind === "request" &&
        settled.request.kind === "approve-secret" &&
        settled.request.shot,
    ).toBeUndefined()
    // Granted: the same step types it without asking again.
    made.agent.send("again")
    await made.until(() => made.running.length === 4)
    expect(made.shown().filter((i) => i.kind === "request")).toHaveLength(1)
    expect(JSON.stringify(made.sends)).not.toContain("hunter2-secret")
    expect(JSON.stringify(seen)).not.toContain("hunter2-secret")
    await made.agent.close()
  }, 60_000)

  it("picks up the vault once it reads (an agent made while it couldn't)", async () => {
    const later: { vault?: Secrets } = {}
    const { llm, seen } = script([
      call("list_secrets", {}),
      { kind: "text", text: "a" },
      call("list_secrets", {}, "c2"),
      { kind: "text", text: "b" },
    ])
    const made = host(llm, undefined, undefined, () => later.vault)
    made.agent.send("which secrets?")
    await made.until(() => made.running.at(-1) === false)
    const vault = new Secrets(
      join(mkdtempSync(join(tmpdir(), "kiframe-vault-")), "vault.json"),
      memoryBackend(),
    )
    later.vault = vault
    await vault.add(
      { name: "acme.password", kind: "password", value: "pw-x" },
      new URL(server.url).origin,
    )
    made.agent.send("and now?")
    await made.until(() => made.running.length === 4)
    const results = made
      .shown()
      .filter((i) => i.kind === "tool")
      .map((t) => (t.kind === "tool" ? t.result : ""))
    expect(results).toEqual(["none", "acme.password"])
    expect(JSON.stringify(seen)).not.toContain("pw-x")
    await made.agent.close()
  }, 60_000)
})

describe("a step as the user reads it", () => {
  it("names the step, its part and its scene", () => {
    const scenes = new Map([["scene-0123456789ab", "login"]])
    expect(stepLabel("scene:scene-0123456789ab/setup/pw", scenes)).toBe(
      "pw, in the setup of scene login",
    )
    expect(stepLabel("scene:scene-0123456789ab/steps/pw", scenes)).toBe(
      "pw, in the steps of scene login",
    )
    expect(stepLabel("scene:scene-ffffffffffff/steps/pw", scenes)).toBe(
      "pw, in the steps of a scene",
    )
    expect(stepLabel("preset:login/pw")).toBe("pw, in the login preset")
    expect(stepLabel("interrupt:session-expired")).toBe("the session-expired interrupt rule")
  })
})
