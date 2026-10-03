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
      result: "failed (target-not-found): …",
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

describe("a tool's line", () => {
  it("says what a call acts on", () => {
    expect(toolDetail({ scene: "s", step: { action: "goto", url: "/projects" } })).toBe(
      "goto /projects",
    )
    expect(toolDetail({ scene: "s", step: { preset: "login" } })).toBe("preset login")
    expect(toolDetail({ id: "tour", title: "Tour", yaml: "…" })).toBe("tour")
    expect(toolDetail({ question: "Which\naccount?" })).toBe("Which account?")
    expect(toolDetail(null)).toBe("")
    expect(toolDetail({ step: { action: "click", target: { name: { nested: 1 } } } })).toBe("click")
  })

  it("reads the loop's failures and the studio's words", () => {
    expect(toolOutcome(toolAborted("run_step")).status).toBe("stopped")
    expect(toolOutcome(toolThrew("run_step", new Error("boom"))).status).toBe("failed")
    expect(toolOutcome({ error: 'scene "x" didn\'t read' })).toMatchObject({ status: "failed" })
    expect(toolOutcome("replay failed: failed (expectation-failed): …").status).toBe("failed")
    expect(toolOutcome("saved: tour (replayed)").status).toBe("ok")
    expect(toolOutcome({ answer: "the demo account" }).status).toBe("ok")
    expect(oneLine("x".repeat(400)).length).toBe(160)
    // run_steps: failed when one of its numbered lines did, that line shown.
    expect(toolOutcome("1. ok. url: /\n2. ok. url: /x", "run_steps")).toEqual({
      status: "ok",
      result: "2 ok; 2. ok. url: /x",
    })
    expect(
      toolOutcome(
        "1. ok. url: /\n2. failed (target-not-found): no Save\nstopped there: the 1 after it didn't run",
        "run_steps",
      ),
    ).toEqual({ status: "failed", result: "2. failed (target-not-found): no Save" })
    expect(toolOutcome("1. invalid step: x", "run_steps").status).toBe("failed")
    expect(toolOutcome("1. ok, but it closed every page", "run_steps").status).toBe("failed")
    // Off the app's site: the batch stopped there, but no step failed.
    expect(
      toolOutcome("1. ok. url: /docs (on github.com: NOT the app's site, minmux.dev)", "run_steps")
        .status,
    ).toBe("ok")
    // A single run_step is read the same way.
    expect(toolOutcome("ok, but it closed every page: …", "run_step").status).toBe("failed")
    expect(
      toolOutcome("ok. url: /x (on github.com: NOT the app's site, a.b)", "run_step").status,
    ).toBe("ok")
    // Another tool's numbered text is never read as run_steps'.
    expect(toolOutcome("1. failed attempts are retried", "list_scenes").status).toBe("ok")
    expect(toolDetail({ scene: "s", steps: [{}, {}, {}] })).toBe("3 steps")
    // Never half an emoji at the cut.
    const cut = oneLine(`${"x".repeat(158)}😀${"y".repeat(10)}`)
    expect(cut).toBe(`${"x".repeat(158)}😀…`)
  })
})
