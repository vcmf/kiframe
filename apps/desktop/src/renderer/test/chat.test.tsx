// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ChatItem, ProjectView } from "../../shared/ipc.ts"
import { App } from "../src/app.tsx"
import { newNeedUser, thoughtFor, turns } from "../src/components/chat-column.tsx"
import { useChat } from "../src/chat-store.ts"
import { useApp } from "../src/store.ts"
import { status, stubApi } from "./stub-api.ts"

const project: ProjectView = {
  session: "s1",
  name: "Demo",
  dir: "/tmp/demo.kiframe",
  url: "https://app.test",
  apps: [{ name: "app", origin: "https://app.test" }],
  scenes: [],
  problems: [],
}

afterEach(() => {
  cleanup()
  useApp.setState({ status: null, busy: null, dismissed: null })
  useChat.setState({ items: [], running: false, model: "", frame: null, refused: null })
})

const open = (answers: Parameters<typeof stubApi>[0] = {}) => {
  const api = stubApi({ "app:status": () => status({ hasKey: true, project }), ...answers })
  render(<App />)
  return api
}

describe("the chat", () => {
  it("sends a message on Enter (Shift+Enter is a new line), and shows the model", async () => {
    const { invoke } = open({ "chat:send": () => null })
    const box = await screen.findByLabelText("Message Kif")
    expect(await screen.findByText("test/model")).toBeTruthy()
    fireEvent.change(box, { target: { value: "Make a demo of invoices" } })
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true })
    expect(invoke).not.toHaveBeenCalledWith("chat:send", expect.anything())
    fireEvent.keyDown(box, { key: "Enter" })
    await act(() => Promise.resolve())
    expect(invoke).toHaveBeenCalledWith("chat:send", "Make a demo of invoices")
    expect((box as HTMLTextAreaElement).value).toBe("")
  })

  it("keeps the message and says why when main refuses it", async () => {
    open({ "chat:send": () => "Kif is still working: stop it first" })
    const box = await screen.findByLabelText("Message Kif")
    fireEvent.change(box, { target: { value: "again" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect((await screen.findByRole("alert")).textContent).toMatch(/still working/)
    expect((box as HTMLTextAreaElement).value).toBe("again")
  })

  it("shows no agent turn for a run that ended quietly (no lone mark)", async () => {
    const { push } = open()
    await screen.findByLabelText("Message Kif")
    act(() => {
      push("chat:item", { kind: "user", id: "u1", text: "hello" })
      push("chat:item", { kind: "end", id: "e1", outcome: "done" })
    })
    const log = screen.getByRole("log", { name: "Messages" })
    expect(within(log).getByText("hello")).toBeTruthy()
    expect(log.querySelectorAll(".agent-turn")).toHaveLength(0)
  })

  it("shows what main folds: messages, steps (grouped), the run's end", async () => {
    const { push } = open()
    await screen.findByLabelText("Message Kif")
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "open projects" },
      { kind: "tool", id: "t1", name: "snapshot", detail: "", status: "ok" },
      {
        kind: "tool",
        id: "t2",
        name: "run_step",
        detail: "click Projects",
        status: "failed",
        result: "failed (target-not-found)",
      },
      { kind: "assistant", id: "a1", text: "It isn't there." },
      { kind: "end", id: "e1", outcome: "stopped" },
    ]
    act(() => {
      for (const item of items) push("chat:item", item)
    })
    const log = screen.getByRole("log", { name: "Messages" })
    expect(within(log).getByText("open projects")).toBeTruthy()
    expect(within(log).getByRole("button", { name: /2 steps · 1 failed/ })).toBeTruthy()
    expect(within(log).getByText("click Projects")).toBeTruthy()
    expect(within(log).getByText("It isn't there.")).toBeTruthy()
    expect(within(log).getByRole("status").textContent).toMatch(/Stopped/)
    // A newer version of an item replaces it.
    act(() =>
      push("chat:item", { kind: "assistant", id: "a1", text: "It isn't there, I'll look again." }),
    )
    expect(within(log).queryByText("It isn't there.")).toBeNull()
  })

  it("shows the agent thinking among its steps (dots), then for how long it thought", async () => {
    const { push } = open()
    await screen.findByLabelText("Message Kif")
    act(() => {
      push("chat:item", { kind: "user", id: "u1", text: "go" })
      push("chat:item", { kind: "thinking", id: "th1" })
    })
    const log = screen.getByRole("log", { name: "Messages" })
    // Thinking alone: its row, no head repeating it.
    expect(log.querySelector(".thinking-row")?.textContent).toBe("Thinking")
    expect(log.querySelector(".thinking-row .thinking-dots")).not.toBeNull()
    expect(within(log).queryByRole("button")).toBeNull()
    act(() => {
      push("chat:item", { kind: "thinking", id: "th1", ms: 95_000 })
      push("chat:item", { kind: "tool", id: "t1", name: "snapshot", detail: "", status: "running" })
    })
    // One group: the thought, then the step.
    expect(log.querySelectorAll(".tool-group")).toHaveLength(1)
    expect(within(log).getByRole("button", { name: "1 step · running" })).toBeTruthy()
    expect(within(log).getByText("Thought for 1m 35s")).toBeTruthy()
    expect(log.querySelector(".thinking-dots")).toBeNull()
  })

  it("says how long a thought took", () => {
    expect([400, 8_000, 59_600, 95_000, 600_000].map(thoughtFor)).toEqual([
      "1s",
      "8s",
      "1m",
      "1m 35s",
      "10m",
    ])
  })

  it("turns the composer into a status bar with Stop while the agent works", async () => {
    const { push, invoke } = open({ "chat:stop": () => undefined })
    await screen.findByLabelText("Message Kif")
    act(() => {
      push("chat:running", true)
      push("chat:item", {
        kind: "tool",
        id: "t1",
        name: "run_step",
        detail: "click Send",
        status: "running",
      })
    })
    expect(screen.queryByLabelText("Message Kif")).toBeNull()
    expect(screen.getAllByRole("status")[0]?.textContent).toMatch(/run_step click Send/)
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(invoke).toHaveBeenCalledWith("chat:stop")
    act(() => push("chat:running", false))
    expect(await screen.findByLabelText("Message Kif")).toBeTruthy()
  })

  it("answers a risky step's approval and a question from their cards", async () => {
    const { push, invoke } = open({ "chat:answer": () => undefined })
    await screen.findByLabelText("Message Kif")
    act(() => {
      push("chat:item", {
        kind: "request",
        id: "r1",
        request: { kind: "approve-risky", scene: "tour", step: "send", action: "click" },
        state: "open",
      })
      push("chat:item", {
        kind: "request",
        id: "r2",
        request: { kind: "question", question: "Which account?" },
        state: "open",
      })
    })
    fireEvent.click(screen.getByRole("button", { name: "Approve this step" }))
    expect(invoke).toHaveBeenCalledWith("chat:answer", "r1", true)
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "the demo one" } })
    fireEvent.click(screen.getByRole("button", { name: "Answer" }))
    expect(invoke).toHaveBeenCalledWith("chat:answer", "r2", "the demo one")
    act(() =>
      push("chat:item", {
        kind: "request",
        id: "r1",
        request: { kind: "approve-risky", scene: "tour", step: "send", action: "click" },
        state: "closed",
      }),
    )
    expect(screen.getByText(/Closed: the run stopped/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Approve this step" })).toBeNull()
  })

  it("asks to add a site: the host first, what's notable, the agent's words as its own", async () => {
    const { push, invoke } = open({ "chat:answer": () => undefined })
    await screen.findByLabelText("Message Kif")
    act(() =>
      push("chat:item", {
        kind: "request",
        id: "r1",
        request: {
          kind: "approve-app",
          name: "docs",
          url: "http://xn--pple-43d.example:8080/",
          host: "xn--pple-43d.example:8080",
          plain: true,
          lookalike: true,
          local: false,
          secrets: 0,
          usedBy: [],
          why: "Kiframe: already approved",
        },
        state: "open",
      }),
    )
    const card = screen.getByRole("generic", { name: "Add a site to the project?" })
    expect(card.textContent).toContain("xn--pple-43d.example:8080")
    expect(card.textContent).toMatch(/Not encrypted/)
    expect(card.textContent).toMatch(/lookalike characters/)
    expect(card.textContent).toMatch(/No secret is shared with it/)
    act(() =>
      push("chat:item", {
        kind: "request",
        id: "r2",
        request: {
          kind: "approve-app",
          name: "docs",
          url: "https://docs.test/",
          host: "docs.test",
          plain: false,
          lookalike: false,
          local: false,
          secrets: 2,
          usedBy: ["Install"],
          why: "",
        },
        state: "open",
      }),
    )
    expect(screen.getByText(/2 saved secrets for this site come with it\./)).toBeTruthy()
    expect(
      screen.getByText(/1 scene already names “docs”: “Install”\. They’ll open this site\./),
    ).toBeTruthy()
    expect(card.textContent).toMatch(
      /Kif says \(pages it read can influence this\): Kiframe: already approved/,
    )
    fireEvent.click(screen.getByRole("button", { name: "Add xn--pple-43d.example:8080" }))
    expect(invoke).toHaveBeenCalledWith("chat:answer", "r1", true)
  })

  it("asks before deleting a file, or replacing one the agent didn't write", async () => {
    const { push, invoke } = open({ "chat:answer": () => undefined })
    await screen.findByLabelText("Message Kif")
    act(() =>
      push("chat:item", {
        kind: "request",
        id: "f1",
        request: { kind: "approve-file", action: "replace", path: "pages/intro/index.html" },
        state: "open",
      }),
    )
    const card = screen.getByRole("generic", { name: "Replace a file?" })
    expect(card.textContent).toMatch(
      /replace the whole of pages\/intro\/index\.html, which it didn’t write/,
    )
    expect(card.textContent).toMatch(/current version is kept/)
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }))
    expect(invoke).toHaveBeenCalledWith("chat:answer", "f1", false)
    // Settled: what the user said, never what happened after (the tool's row says that).
    act(() =>
      push("chat:item", {
        kind: "request",
        id: "f1",
        request: { kind: "approve-file", action: "replace", path: "pages/intro/index.html" },
        state: "answered",
        answer: true,
      }),
    )
    expect(screen.getByRole("generic", { name: "Replace a file?" }).textContent).toMatch(
      /Allowed to replace it\./,
    )
  })

  it("only lets the user decline a request this version can't show", async () => {
    const { push, invoke } = open({ "chat:answer": () => undefined })
    await screen.findByLabelText("Message Kif")
    act(() =>
      push("chat:item", {
        kind: "request",
        id: "r9",
        request: { kind: "approve-future" } as never,
        state: "open",
      }),
    )
    expect(screen.queryByLabelText("Your answer")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Decline" }))
    expect(invoke).toHaveBeenCalledWith("chat:answer", "r9", false)
  })

  it("shows the live app when a run starts, its frames as they come", async () => {
    const { push } = open()
    await screen.findByLabelText("Message Kif")
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true")
    act(() => {
      push("chat:running", true)
      push("live:frame", { jpeg: "AAAA", path: "/projects", gen: 1 })
    })
    expect(screen.getByRole("tab", { name: /Live app/ }).getAttribute("aria-selected")).toBe("true")
    const img = screen.getByRole("img", { name: "The live app at /projects" })
    expect(img.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA")
    expect(screen.getByText("Kif is driving")).toBeTruthy()
  })

  it("loads the open project's chat (after a reload), keeping newer items", async () => {
    stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "chat:state": () => ({
        items: [{ kind: "user", id: "u1", text: "earlier message" }],
        running: true,
        model: "test/model",
        frame: { jpeg: "BBBB", path: "/projects", gen: 1 },
      }),
    })
    render(<App />)
    expect(await screen.findByText("earlier message")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy()
    // Where the run is: the last frame comes back too.
    expect(screen.getByRole("img", { name: "The live app at /projects" })).toBeTruthy()
  })

  it("starts the chat afresh when a project opens again (another one, or the same folder reopened)", async () => {
    const { push } = open()
    await screen.findByLabelText("Message Kif")
    act(() => {
      push("chat:item", { kind: "user", id: "user-a-1", text: "project A's message" })
      push("live:frame", { jpeg: "AAAA", path: "/a", gen: 1 })
    })
    expect(screen.getByText("project A's message")).toBeTruthy()
    act(() => push("status", status({ hasKey: true, project: { ...project, session: "s2" } })))
    await screen.findByLabelText("Message Kif")
    expect(screen.queryByText("project A's message")).toBeNull()
    expect(useChat.getState().frame).toBeNull()
  })
})

describe("bringing the chat's log to its end", () => {
  const text = (id: string): ChatItem => ({ kind: "assistant", id, text: id })
  const ask = (id: string, state: "open" | "answered"): ChatItem => ({
    kind: "request",
    id,
    request: { kind: "question", question: "Which?" },
    state,
  })
  it("sees every item not seen before, appended or in a whole new list", () => {
    // A request the run waits on, then a text, in one render: still brought into view.
    expect(newNeedUser([text("a"), ask("q", "open"), text("b")], new Set(["a"]))).toBe(true)
    expect(newNeedUser([text("a"), ask("q", "open"), text("b")], new Set(["a", "q"]))).toBe(false)
    // An answered request, or a request updated in place (seen already): not again.
    expect(newNeedUser([text("a"), ask("q", "answered")], new Set(["a"]))).toBe(false)
    expect(newNeedUser([text("a"), ask("q", "open")], new Set(["a", "q"]))).toBe(false)
    // A whole list at once (the chat's state after two upserts): its open request found.
    const seen = new Set(["x", "y"])
    expect(newNeedUser([text("a"), ask("q", "open"), text("x"), text("y")], seen)).toBe(true)
    expect(seen.has("q")).toBe(true)
    // The user's own message.
    expect(newNeedUser([{ kind: "user", id: "u", text: "hi" }], new Set())).toBe(true)
  })
})

describe("the chat's turns", () => {
  it("puts everything the agent did between two user messages under one mark", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "Make it" },
      { kind: "assistant", id: "a1", text: "Looking." },
      { kind: "tool", id: "t1", name: "snapshot", detail: "", status: "ok" },
      { kind: "tool", id: "t2", name: "run_step", detail: "", status: "ok" },
      { kind: "end", id: "e1", outcome: "error", message: "401 User not found." },
      { kind: "user", id: "u2", text: "Again" },
      { kind: "end", id: "e2", outcome: "error", message: "401 User not found." },
    ]
    const shape = turns(items).map((t) =>
      t.kind === "user"
        ? t.item.id
        : t.blocks.map((b) => (b.kind === "steps" ? b.steps.length : b.item.id)),
    )
    // An error alone is a turn too (its mark shown).
    expect(shape).toEqual(["u1", ["a1", 2, "e1"], "u2", ["e2"]])
  })
})
