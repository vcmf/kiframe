// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ChatItem, ProjectView } from "../../shared/ipc.ts"
import { App } from "../src/app.tsx"
import { useChat } from "../src/chat-store.ts"
import { useApp } from "../src/store.ts"
import { status, stubApi } from "./stub-api.ts"

const project: ProjectView = {
  session: "s1",
  name: "Demo",
  dir: "/tmp/demo.kiframe",
  url: "https://app.test",
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
    const box = await screen.findByLabelText("Message the agent")
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
    open({ "chat:send": () => "the agent is still working: stop it first" })
    const box = await screen.findByLabelText("Message the agent")
    fireEvent.change(box, { target: { value: "again" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    expect((await screen.findByRole("alert")).textContent).toMatch(/still working/)
    expect((box as HTMLTextAreaElement).value).toBe("again")
  })

  it("shows what main folds: messages, steps (grouped), the run's end", async () => {
    const { push } = open()
    await screen.findByLabelText("Message the agent")
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

  it("turns the composer into a status bar with Stop while the agent works", async () => {
    const { push, invoke } = open({ "chat:stop": () => undefined })
    await screen.findByLabelText("Message the agent")
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
    expect(screen.queryByLabelText("Message the agent")).toBeNull()
    expect(screen.getAllByRole("status")[0]?.textContent).toMatch(/run_step click Send/)
    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(invoke).toHaveBeenCalledWith("chat:stop")
    act(() => push("chat:running", false))
    expect(await screen.findByLabelText("Message the agent")).toBeTruthy()
  })

  it("answers a risky step's approval and a question from their cards", async () => {
    const { push, invoke } = open({ "chat:answer": () => undefined })
    await screen.findByLabelText("Message the agent")
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

  it("shows the live app when a run starts, its frames as they come", async () => {
    const { push } = open()
    await screen.findByLabelText("Message the agent")
    expect(screen.getByRole("tab", { name: "Preview" }).getAttribute("aria-selected")).toBe("true")
    act(() => {
      push("chat:running", true)
      push("live:frame", { jpeg: "AAAA", path: "/projects" })
    })
    expect(screen.getByRole("tab", { name: /Live app/ }).getAttribute("aria-selected")).toBe("true")
    const img = screen.getByRole("img", { name: "The live app at /projects" })
    expect(img.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA")
    expect(screen.getByText("Agent driving")).toBeTruthy()
  })

  it("loads the open project's chat (after a reload), keeping newer items", async () => {
    stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "chat:state": () => ({
        items: [{ kind: "user", id: "u1", text: "earlier message" }],
        running: true,
        model: "test/model",
        frame: { jpeg: "BBBB", path: "/projects" },
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
    await screen.findByLabelText("Message the agent")
    act(() => {
      push("chat:item", { kind: "user", id: "user-a-1", text: "project A's message" })
      push("live:frame", { jpeg: "AAAA", path: "/a" })
    })
    expect(screen.getByText("project A's message")).toBeTruthy()
    act(() => push("status", status({ hasKey: true, project: { ...project, session: "s2" } })))
    await screen.findByLabelText("Message the agent")
    expect(screen.queryByText("project A's message")).toBeNull()
    expect(useChat.getState().frame).toBeNull()
  })
})
