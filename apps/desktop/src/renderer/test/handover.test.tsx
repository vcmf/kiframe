// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ProjectView } from "../../shared/ipc.ts"
import { App } from "../src/app.tsx"
import { useChat } from "../src/chat-store.ts"
import { pointOn } from "../src/components/live-control.tsx"
import { useApp } from "../src/store.ts"
import { status, stubApi } from "./stub-api.ts"

// A handover in the window: the card (the page's origin beside the agent's words), the live app
// taking the user's input only while it's open.

const project: ProjectView = {
  session: "s1",
  name: "Demo",
  dir: "/tmp/demo.kiframe",
  apps: [{ name: "app", kind: "web", origin: "https://app.test" }],
  scenes: [],
  problems: [],
}

afterEach(() => {
  cleanup()
  useApp.setState({ status: null, busy: null, dismissed: null })
  useChat.setState({ items: [], running: false, model: "", frame: null, refused: null })
})

const request = (onApp: boolean, state: "open" | "answered" = "open") => ({
  kind: "request" as const,
  id: "h1",
  request: {
    kind: "handover" as const,
    task: "Enter the code from your phone",
    origin: onApp ? "https://app.test" : "https://app-test.evil",
    onApp,
    where: "live" as const,
  },
  state,
})

describe("a handover in the window", () => {
  it("shows the agent's task beside the page's origin, warns off the project's apps, and answers with a note", async () => {
    const { push, invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "chat:answer": () => undefined,
      "live:input": () => undefined,
    })
    render(<App />)
    await screen.findByLabelText("Message Kif")
    act(() => {
      push("chat:running", true)
      push("chat:item", request(false))
    })
    const card = screen.getByRole("generic", { name: "Take over the browser" })
    expect(card.textContent).toMatch(/Enter the code from your phone/)
    expect(card.textContent).toMatch(/https:\/\/app-test\.evil/)
    expect(card.textContent).toMatch(/not one of this project’s apps/)
    expect(card.textContent).toMatch(/For a password, use Secrets/)
    fireEvent.change(screen.getByLabelText("A note for Kif"), {
      target: { value: "used a backup code" },
    })
    // Hiding what was typed: the user's call (on by default).
    fireEvent.click(screen.getByLabelText("Hide what I typed from Kif"))
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(invoke).toHaveBeenCalledWith("chat:answer", "h1", {
      outcome: "done",
      note: "used a backup code",
      hide: false,
    })
  })

  it("takes the user's input on the live app only while it's open, on the frame they saw", async () => {
    const { push, invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "live:input": () => undefined,
    })
    render(<App />)
    await screen.findByLabelText("Message Kif")
    act(() => {
      push("chat:running", true)
      push("live:frame", { jpeg: "AAAA", path: "/login", gen: 7 })
    })
    // No handover: the frame is a picture only.
    expect(screen.queryByLabelText("Type into the live app")).toBeNull()
    act(() => push("chat:item", request(true)))
    expect(screen.getByText("You’re in control")).toBeTruthy()
    const typing = screen.getByLabelText<HTMLTextAreaElement>("Type into the live app")
    typing.value = "4821"
    fireEvent.input(typing)
    expect(invoke).toHaveBeenCalledWith("live:input", "h1", 7, { kind: "text", text: "4821" })
    fireEvent.keyDown(typing, { key: "Enter" })
    expect(invoke).toHaveBeenCalledWith("live:input", "h1", 7, {
      kind: "key",
      key: "Enter",
      modifiers: [],
    })
    // A shortcut: pressed once with its modifiers (never held: macOS sends no key-up for it).
    fireEvent.keyDown(typing, { key: "a", metaKey: true })
    expect(invoke).toHaveBeenCalledWith("live:input", "h1", 7, {
      kind: "key",
      key: "a",
      modifiers: ["Meta"],
    })
    // A shortcut paste never goes as keys (the paste itself brings the text).
    fireEvent.keyDown(typing, { key: "v", metaKey: true })
    expect(invoke).not.toHaveBeenCalledWith(
      "live:input",
      "h1",
      7,
      expect.objectContaining({ key: "v" }),
    )
    // AltGr / Option make text, never a shortcut: left to the text.
    fireEvent.keyDown(typing, { key: "@", ctrlKey: true, altKey: true })
    fireEvent.keyDown(typing, { key: "q", ctrlKey: true, altKey: true })
    expect(invoke).not.toHaveBeenCalledWith(
      "live:input",
      "h1",
      7,
      expect.objectContaining({ key: "q" }),
    )
    // Modifiers alone: never sent.
    fireEvent.keyDown(typing, { key: "Shift", shiftKey: true })
    expect(invoke).not.toHaveBeenCalledWith(
      "live:input",
      "h1",
      7,
      expect.objectContaining({ key: "Shift" }),
    )
    // A button released outside the frame: released all the same.
    const img = screen.getByRole("img", { name: /taking your input/ })
    Object.defineProperty(img, "naturalWidth", { value: 800 })
    Object.defineProperty(img, "naturalHeight", { value: 600 })
    img.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect
    fireEvent.mouseDown(img, { clientX: 100, clientY: 100, button: 0 })
    fireEvent.mouseUp(window, { button: 0 })
    expect(invoke).toHaveBeenCalledWith(
      "live:input",
      "h1",
      7,
      expect.objectContaining({ kind: "mouse", type: "up", button: "left" }),
    )
    // Answered: the live app is a picture again.
    act(() =>
      push("chat:item", {
        ...request(true, "answered"),
        answer: { outcome: "done", note: "", hide: true },
      }),
    )
    expect(screen.queryByLabelText("Type into the live app")).toBeNull()
  })

  it("maps a point on a letterboxed frame to fractions of its picture", () => {
    // A 1600×900 picture in a 800×600 box: shown 800×450, 75 px bars above and below.
    const box = { left: 0, top: 0, width: 800, height: 600 }
    const natural = { width: 1600, height: 900 }
    expect(pointOn(box, natural, { x: 400, y: 300 })).toEqual({ x: 0.5, y: 0.5 })
    expect(pointOn(box, natural, { x: 0, y: 75 })).toEqual({ x: 0, y: 0 })
    expect(pointOn(box, natural, { x: 400, y: 50 })).toBeUndefined()
  })
})
