import { toolAborted, toolThrew } from "@kiframe/agent"
import { describe, expect, it } from "vitest"
import { ChatLog, oneLine, toolDetail, toolOutcome } from "../src/main/chat-log.ts"

describe("the chat, folded from the agent's events", () => {
  it("replaces a turn's text as it streams, and starts a new answer after a tool", () => {
    const log = new ChatLog()
    log.user("make a demo")
    const [a] = log.event({ type: "assistant_text", text: "Look" })
    const [b] = log.event({ type: "assistant_text", text: "Looking at the app" })
    expect(b?.id).toBe(a?.id)
    log.event({ type: "tool_start", callId: "c1", toolName: "snapshot", args: {} })
    const [c] = log.event({ type: "assistant_text", text: "Done" })
    expect(c?.id).not.toBe(a?.id)
    expect(log.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "assistant"])
    expect(log.items[1]).toMatchObject({ text: "Looking at the app" })
  })

  it("shows each stretch of thinking once, never its words, then how long it took", () => {
    let now = 0
    const log = new ChatLog(() => now)
    // The streamed thinking: one item, opened by the first piece.
    expect(log.event({ type: "reasoning", text: "The page" })).toEqual([
      { kind: "thinking", id: expect.any(String) as unknown },
    ])
    now = 95_000
    expect(log.event({ type: "reasoning", text: "The page is long" })).toEqual([])
    // A tool call ends it.
    log.event({ type: "tool_start", callId: "c1", toolName: "snapshot", args: {} })
    log.event({ type: "tool_result", callId: "c1", toolName: "snapshot", result: "url: /" })
    now = 100_000
    log.event({ type: "reasoning", text: "Done" })
    now = 102_500
    // So does the run's end.
    log.event({ type: "done", messages: [] })
    expect(log.items.map((i) => (i.kind === "thinking" ? i.ms : i.kind))).toEqual([
      95_000,
      "tool",
      2_500,
      "end",
    ])
    expect(JSON.stringify(log.items)).not.toContain("The page")
  })

  it("keeps one row for a reply that thinks, says something, then thinks again", () => {
    let now = 0
    const log = new ChatLog(() => now)
    log.event({ type: "reasoning", text: "a" })
    now = 3000
    // An empty piece of text: still thinking.
    expect(log.event({ type: "assistant_text", text: "" })).toEqual([])
    expect(log.items[0]).not.toHaveProperty("ms")
    log.event({ type: "assistant_text", text: "Let me" })
    now = 4000
    log.event({ type: "reasoning", text: "a b" })
    expect(log.items.map((i) => i.kind)).toEqual(["thinking", "assistant"])
    expect(log.items[0]).not.toHaveProperty("ms")
    now = 6000
    log.event({ type: "assistant_text", text: "Let me check." })
    expect(log.items[0]).toMatchObject({ kind: "thinking", ms: 5000 })
    // A new reply (after a tool call): a row of its own.
    log.event({ type: "tool_start", callId: "c", toolName: "snapshot", args: {} })
    log.event({ type: "reasoning", text: "x" })
    expect(log.items.filter((i) => i.kind === "thinking")).toHaveLength(2)
  })

  it("shows a tool running, then how it ended (the studio's failures are words)", () => {
    const log = new ChatLog()
    const step = {
      id: "open",
      action: "click",
      target: { by: "role", role: "link", name: "Projects" },
    }
    log.event({
      type: "tool_start",
      callId: "c1",
      toolName: "run_step",
      args: { scene: "tour", step },
    })
    expect(log.items[0]).toMatchObject({ status: "running", detail: "click Projects" })
    log.event({
      type: "tool_result",
      callId: "c1",
      toolName: "run_step",
      result: "ok. url: /projects",
    })
    expect(log.items[0]).toMatchObject({ status: "ok", result: "ok. url: /projects" })
    log.event({
      type: "tool_start",
      callId: "c2",
      toolName: "run_step",
      args: { scene: "tour", step },
    })
    log.event({
      type: "tool_result",
      callId: "c2",
      toolName: "run_step",
      result: { error: "failed (target-not-found): …" },
    })
    expect(log.items[1]).toMatchObject({ status: "failed" })
  })

  it("marks what the run's end left running as stopped, and says how it ended", () => {
    const log = new ChatLog()
    log.event({ type: "tool_start", callId: "c1", toolName: "record_scene", args: { id: "tour" } })
    const changed = log.event({ type: "aborted", messages: [] })
    expect(changed).toMatchObject([
      { kind: "tool", status: "stopped", detail: "tour" },
      { kind: "end", outcome: "stopped" },
    ])
    expect(
      log.event({ type: "error", message: "rate limited\nretry later", messages: [] }),
    ).toMatchObject([{ kind: "end", outcome: "error", message: "rate limited retry later" }])
    expect(log.event({ type: "turn_limit", maxTurns: 40, messages: [] })[0]).toMatchObject({
      outcome: "turn_limit",
      message: "stopped after 40 turns",
    })
    expect(log.event({ type: "done", messages: [], truncated: true })[0]).toMatchObject({
      outcome: "done",
      message: expect.stringMatching(/cut short/) as unknown,
    })
  })

  it("gives a call its own row even when the provider reuses its id, and never meets another log's ids", () => {
    const log = new ChatLog()
    log.event({ type: "tool_start", callId: "call_0", toolName: "snapshot", args: {} })
    log.event({ type: "tool_result", callId: "call_0", toolName: "snapshot", result: "url: /" })
    log.event({ type: "tool_start", callId: "call_0", toolName: "run_step", args: {} })
    log.event({
      type: "tool_result",
      callId: "call_0",
      toolName: "run_step",
      result: "ok. url: /x",
    })
    expect(log.items).toMatchObject([
      { name: "snapshot", status: "ok" },
      { name: "run_step", status: "ok" },
    ])
    const other = new ChatLog()
    expect(other.user("hi").id).not.toBe(new ChatLog().user("hi").id)
  })

  it("keeps a request open until answered or closed, once", () => {
    const log = new ChatLog()
    const item = log.request({
      kind: "approve-risky",
      scene: "tour",
      step: "steps[2]",
      action: "click",
    })
    expect(item).toMatchObject({ state: "open" })
    expect(log.settle(item.id, { answer: true })).toMatchObject({ state: "answered", answer: true })
    expect(log.settle(item.id, "closed")).toBeUndefined()
    const other = log.request({ kind: "question", question: "Which account?" })
    expect(log.settle(other.id, "closed")).toMatchObject({ state: "closed" })
  })
})

describe("a run the host stopped", () => {
  it("ends with why (a secret's value refused in a file), and the next message clears it", () => {
    const log = new ChatLog()
    log.user("make a page")
    log.stopReason =
      "Kif tried to write a secret's value into pages/a.html: refused, and the run stopped"
    const [end] = log.event({ type: "aborted", messages: [] }).slice(-1)
    expect(end).toMatchObject({ kind: "end", outcome: "stopped", message: log.stopReason })
    log.user("again")
    expect(log.stopReason).toBeUndefined()
  })
})

describe("a tool's line", () => {
  it("says what a call acts on", () => {
    expect(toolDetail({ scene: "s", step: { action: "goto", url: "/projects" } })).toBe(
      "goto /projects",
    )
    expect(toolDetail({ scene: "s", step: { preset: "login" } })).toBe("preset login")
    expect(toolDetail({ id: "tour", title: "Tour", yaml: "…" })).toBe("tour")
    // A file tool: the file it acts on; a copy, from → to.
    expect(toolDetail({ path: "pages/intro/index.html", content: "<p>…</p>" })).toBe(
      "pages/intro/index.html",
    )
    expect(toolDetail({ from: "inputs/logo.png", to: "pages/logo.png" })).toBe(
      "inputs/logo.png → pages/logo.png",
    )
    expect(toolDetail({ question: "Which\naccount?" })).toBe("Which account?")
    expect(toolDetail(null)).toBe("")
    expect(toolDetail({ step: { action: "click", target: { name: { nested: 1 } } } })).toBe("click")
  })

  it("reads a failure from the protocol (`{ error }`), never from words", () => {
    expect(toolOutcome(toolAborted("run_step")).status).toBe("stopped")
    expect(toolOutcome(toolThrew("run_step", new Error("boom"))).status).toBe("failed")
    expect(toolOutcome({ error: 'scene "x" didn\'t read' })).toMatchObject({ status: "failed" })
    expect(toolOutcome("saved: tour (replayed)").status).toBe("ok")
    expect(toolOutcome({ answer: "the demo account" }).status).toBe("ok")
    expect(oneLine("x".repeat(400)).length).toBe(160)
    // Text is a success whatever its words (a page's own text may say "failed"), its first line
    // shown; a failure comes as `{ error }`, its reason first.
    expect(toolOutcome("2 steps ok\n1. ok. url: /\n2. ok. url: /x")).toEqual({
      status: "ok",
      result: "2 steps ok",
    })
    expect(
      toolOutcome({
        error: "step 2 failed (target-not-found): no Save\n1. ok. url: /\n2. failed …",
      }),
    ).toMatchObject({
      status: "failed",
      result: expect.stringMatching(/^step 2 failed \(/) as unknown,
    })
    expect(toolOutcome("ok. url: /failed-payments").status).toBe("ok")
    expect(toolOutcome("failed attempts are retried").status).toBe("ok")
    expect(toolOutcome({ error: "recording failed: no complete take" }).status).toBe("failed")
    expect(toolDetail({ scene: "s", steps: [{}, {}, {}] })).toBe("3 steps")
    // Never half an emoji at the cut.
    const cut = oneLine(`${"x".repeat(158)}😀${"y".repeat(10)}`)
    expect(cut).toBe(`${"x".repeat(158)}😀…`)
  })
})
