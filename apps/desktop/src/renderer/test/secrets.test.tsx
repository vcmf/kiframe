// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ChatItem, ProjectView, SecretView } from "../../shared/ipc.ts"
import { App } from "../src/app.tsx"
import { useChat } from "../src/chat-store.ts"
import { useApp } from "../src/store.ts"
import { status, stubApi } from "./stub-api.ts"

const project: ProjectView = {
  session: "s1",
  name: "Demo",
  dir: "/tmp/demo.kiframe",
  url: "https://app.test/home",
  scenes: [],
  problems: [],
}

afterEach(() => {
  cleanup()
  useApp.setState({ status: null, busy: null, dismissed: null })
  useChat.setState({ items: [], running: false, model: "", frame: null, refused: null })
})

const approval = (state: "open" | "answered" = "open"): ChatItem => ({
  kind: "request",
  id: "r1",
  state,
  request: {
    kind: "approve-secret",
    secret: "acme.password",
    element: { tag: "input", type: "password", label: "Password" },
    origin: "https://app.test",
    path: "/login",
    step: "pw, in the setup",
    shot: { jpeg: "AAAA", width: 800, height: 600 },
    box: { x: 200, y: 150, width: 400, height: 30 },
  },
})

describe("a secret's approval", () => {
  it("shows the page with the field outlined, what and where; Allow answers yes", async () => {
    const { push, invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "chat:answer": () => undefined,
    })
    render(<App />)
    await screen.findByLabelText("Message the agent")
    act(() => push("chat:item", approval()))
    const dialog = screen.getByRole("dialog", { name: "Type a secret here?" })
    expect(within(dialog).getByRole("img").getAttribute("src")).toBe("data:image/jpeg;base64,AAAA")
    const outline = within(dialog).getByTestId("secret-outline")
    expect(outline.style.left).toBe("25%")
    expect(outline.style.top).toBe("25%")
    expect(outline.style.width).toBe("50%")
    expect(dialog.textContent).toMatch(/Password · an input of type password/)
    expect(dialog.textContent).toMatch(/https:\/\/app\.test\/login/)
    expect(dialog.textContent).toMatch(/pw, in the setup/)
    // Declining is the default: focused first.
    expect(document.activeElement?.textContent).toBe("Decline")
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow here" }))
    expect(invoke).toHaveBeenCalledWith("chat:answer", "r1", true)
    act(() => push("chat:item", { ...approval("answered"), answer: true } as ChatItem))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByText(/Allowed: later takes type it/)).toBeTruthy()
  })

  it("declines on Escape", async () => {
    const { push, invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "chat:answer": () => undefined,
    })
    render(<App />)
    await screen.findByLabelText("Message the agent")
    act(() => push("chat:item", approval()))
    fireEvent.keyDown(document, { key: "Escape" })
    expect(invoke).toHaveBeenCalledWith("chat:answer", "r1", false)
  })
})

describe("the secrets panel", () => {
  it("lists the project's secrets, adds one (its value never kept in the window), removes one", async () => {
    let listed: SecretView[] = []
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "secrets:list": () => listed,
      "secrets:add": () => {
        listed = [
          {
            name: "acme.password",
            kind: "password",
            origins: ["https://app.test"],
            provided: true,
          },
        ]
        return null
      },
      "secrets:remove": () => {
        listed = []
        return null
      },
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: "Secrets" }))
    const panel = screen.getByRole("dialog", { name: "Secrets" })
    expect(panel.textContent).toMatch(/https:\/\/app\.test/)
    expect(await within(panel).findByText("No secrets yet.")).toBeTruthy()
    fireEvent.change(within(panel).getByLabelText("Name"), { target: { value: "acme.password" } })
    fireEvent.change(within(panel).getByLabelText("Value"), { target: { value: "hunter2-secret" } })
    fireEvent.click(within(panel).getByRole("button", { name: "Add secret" }))
    expect(await within(panel).findByText("acme.password")).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith("secrets:add", {
      name: "acme.password",
      kind: "password",
      value: "hunter2-secret",
    })
    expect(within(panel).getByLabelText("Value")).toHaveProperty("value", "")
    expect(document.body.innerHTML).not.toContain("hunter2-secret")
    fireEvent.click(within(panel).getByRole("button", { name: "Remove acme.password" }))
    fireEvent.click(within(panel).getByRole("button", { name: "Remove acme.password" }))
    expect(await within(panel).findByText("No secrets yet.")).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith("secrets:remove", "acme.password")
  })

  it("says why a secret wasn't added, and keeps the form", async () => {
    stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "secrets:list": () => [],
      "secrets:add": () => "Invalid secret name: must be a secret name, never a secret value",
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: "Secrets" }))
    const panel = screen.getByRole("dialog", { name: "Secrets" })
    fireEvent.change(within(panel).getByLabelText("Name"), { target: { value: "hunter2 pw" } })
    fireEvent.change(within(panel).getByLabelText("Value"), { target: { value: "x" } })
    fireEvent.click(within(panel).getByRole("button", { name: "Add secret" }))
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/never a secret value/)
    expect(within(panel).getByLabelText("Name")).toHaveProperty("value", "hunter2 pw")
  })

  it("leaves the panel open when Escape declines an approval over it", async () => {
    const { push, invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "secrets:list": () => [],
      "chat:answer": () => undefined,
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: "Secrets" }))
    act(() => push("chat:item", approval()))
    fireEvent.keyDown(document, { key: "Escape" })
    expect(invoke).toHaveBeenCalledWith("chat:answer", "r1", false)
    expect(screen.getByRole("dialog", { name: "Secrets" })).toBeTruthy()
  })
})
