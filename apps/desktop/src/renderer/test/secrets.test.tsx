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
  apps: [{ name: "app", origin: "https://app.test" }],
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
    // The dialog itself takes focus (no button: a stray key never answers it).
    expect(document.activeElement).toBe(dialog)
    fireEvent.keyDown(dialog, { key: " " })
    fireEvent.keyDown(dialog, { key: "Enter" })
    expect(invoke).not.toHaveBeenCalledWith("chat:answer", expect.anything(), expect.anything())
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
    const groups = () => [{ app: "app", origin: "https://app.test", secrets: listed }]
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "secrets:list": groups,
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
    // The limits said plainly: a throwaway account; what can't be hidden.
    expect(panel.textContent).toMatch(/Use a throwaway demo account/)
    expect(panel.textContent).toMatch(/drawn in an image or a canvas\s+can’t be hidden/)
    expect(await within(panel).findByText("No secrets yet.")).toBeTruthy()
    fireEvent.change(within(panel).getByLabelText("Name"), { target: { value: "acme.password" } })
    fireEvent.change(within(panel).getByLabelText("Value"), { target: { value: "hunter2-secret" } })
    fireEvent.click(within(panel).getByRole("button", { name: "Add secret" }))
    expect(await within(panel).findByText("acme.password")).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith("secrets:add", {
      session: project.session,
      app: "app",
      name: "acme.password",
      kind: "password",
      value: "hunter2-secret",
    })
    expect(within(panel).getByLabelText("Value")).toHaveProperty("value", "")
    expect(document.body.innerHTML).not.toContain("hunter2-secret")
    fireEvent.click(within(panel).getByRole("button", { name: "Remove acme.password" }))
    fireEvent.click(within(panel).getByRole("button", { name: "Remove acme.password" }))
    expect(await within(panel).findByText("No secrets yet.")).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith("secrets:remove", {
      session: project.session,
      app: "app",
      name: "acme.password",
    })
  })

  it("shows a project's secrets app by app, and adds one for the app picked (by its name)", async () => {
    const two: ProjectView = {
      ...project,
      apps: [
        { name: "app", origin: "https://app.test" },
        { name: "docs", origin: "https://docs.test" },
      ],
    }
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project: two }),
      "secrets:list": () => [
        {
          app: "app",
          origin: "https://app.test",
          secrets: [{ name: "acme.password", kind: "password", origins: [], provided: true }],
        },
        {
          app: "docs",
          origin: "https://docs.test",
          secrets: [{ name: "docs.token", kind: "api_key", origins: [], provided: false }],
        },
      ],
      "secrets:add": () => null,
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: "Secrets" }))
    const panel = screen.getByRole("dialog", { name: "Secrets" })
    const docs = await within(panel).findByRole("list", { name: "Secrets of docs" })
    expect(within(docs).getByText("docs.token")).toBeTruthy()
    expect(within(panel).getByRole("list", { name: "Secrets of app" }).textContent).toMatch(
      /acme\.password/,
    )
    fireEvent.change(within(panel).getByLabelText("App"), { target: { value: "docs" } })
    fireEvent.change(within(panel).getByLabelText("Name"), { target: { value: "docs.key" } })
    fireEvent.change(within(panel).getByLabelText("Value"), { target: { value: "k" } })
    fireEvent.click(within(panel).getByRole("button", { name: "Add secret" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith("secrets:add", {
      session: "s1",
      app: "docs",
      name: "docs.key",
      kind: "password",
      value: "k",
    })
  })

  it("asks no app when the project has one", async () => {
    stubApi({ "app:status": () => status({ hasKey: true, project }), "secrets:list": () => [] })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: "Secrets" }))
    const panel = screen.getByRole("dialog", { name: "Secrets" })
    expect(within(panel).queryByLabelText("App")).toBeNull()
  })

  it("never moves focus while a value is typed (a status update re-renders the window)", async () => {
    const { push } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "secrets:list": () => [],
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: "Secrets" }))
    const panel = screen.getByRole("dialog", { name: "Secrets" })
    const value = within(panel).getByLabelText("Value")
    value.focus()
    act(() =>
      push("status", status({ hasKey: true, project: { ...project, name: "Demo (saved)" } })),
    )
    expect(document.activeElement).toBe(value)
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
