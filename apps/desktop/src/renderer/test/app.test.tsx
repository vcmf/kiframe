// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "../src/app.tsx"
import { useApp } from "../src/store.ts"
import { status, stubApi } from "./stub-api.ts"

const project = {
  name: "Acme Billing demo",
  dir: "/tmp/demo.kiframe",
  url: "https://app.acme.example",
  scenes: [
    { id: "intro", title: "Intro" as const, status: "card" as const },
    {
      id: "invoice",
      title: "Create an invoice",
      kind: "recording" as const,
      status: "recorded" as const,
    },
    {
      id: "send",
      title: "Send to a client",
      kind: "recording" as const,
      status: "grounded" as const,
    },
  ],
  problems: [],
}

afterEach(() => {
  cleanup()
  useApp.setState({ status: null, busy: null })
})

describe("the window", () => {
  it("asks for the key first, sends it to main, and moves on when main says so", async () => {
    const { invoke } = stubApi({
      "app:status": () => status(),
      "key:set": () => status({ hasKey: true }),
    })
    render(<App />)
    const field = await screen.findByLabelText("OpenRouter API key")
    const save = screen.getByRole("button", { name: "Save key" })
    expect(save).toHaveProperty("disabled", true)
    fireEvent.change(field, { target: { value: "sk-or-abc" } })
    fireEvent.click(save)
    expect(await screen.findByRole("heading", { name: "Start a demo" })).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith("key:set", "sk-or-abc")
  })

  it("creates a project with a name and an address, and shows main's refusal of a bad one", async () => {
    let calls = 0
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true }),
      // Main checks the address by the project's rule: the first is refused, the second taken.
      "project:create": () =>
        (calls += 1) === 1
          ? status({ hasKey: true, error: "App address: Invalid URL" })
          : status({ hasKey: true, project }),
    })
    render(<App />)
    const create = await screen.findByRole("button", { name: "Create project…" })
    expect(create).toHaveProperty("disabled", true)
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Acme" } })
    expect(create).toHaveProperty("disabled", true)
    fireEvent.change(screen.getByLabelText("App address"), { target: { value: "ftp://x" } })
    fireEvent.click(create)
    expect((await screen.findByRole("alert")).textContent).toMatch(/App address/)
    fireEvent.change(screen.getByLabelText("App address"), {
      target: { value: "https://app.acme.example" },
    })
    fireEvent.click(create)
    await screen.findByRole("region", { name: "Scenes" })
    expect(invoke).toHaveBeenLastCalledWith("project:create", {
      name: "Acme",
      url: "https://app.acme.example",
    })
  })

  it("shows the scenes in story order with their status", async () => {
    stubApi({ "app:status": () => status({ hasKey: true, project }) })
    render(<App />)
    const strip = await screen.findByRole("region", { name: "Scenes" })
    const cards = within(strip).getAllByRole("button")
    expect(cards.map((c) => c.textContent)).toEqual([
      "IntroIntroTitle card",
      "Create an invoiceRecorded",
      "Send to a clientGrounded · not filmed",
    ])
    fireEvent.click(cards[1]!)
    expect(cards[1]?.getAttribute("aria-pressed")).toBe("true")
  })

  it("shows main's error, and follows the status main pushes", async () => {
    const { push } = stubApi({
      "app:status": () => status({ hasKey: true, error: "demo.kiframe already holds a project" }),
    })
    render(<App />)
    expect((await screen.findByRole("alert")).textContent).toMatch(/already holds a project/)
    act(() => push("status", status({ hasKey: true, project })))
    await waitFor(() => expect(screen.getByRole("region", { name: "Scenes" })).toBeTruthy())
  })

  it("closes the project from its menu", async () => {
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "project:close": () => status({ hasKey: true }),
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /Acme Billing demo/ }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Close project" }))
    expect(await screen.findByRole("heading", { name: "Start a demo" })).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith("project:close")
  })

  it("shows an action's failure in the workspace, until dismissed", async () => {
    stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "project:open": () =>
        status({ hasKey: true, project, error: "not a project: project.json is missing" }),
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /Acme Billing demo/ }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Open another project…" }))
    expect((await screen.findByRole("alert")).textContent).toMatch(/project.json is missing/)
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("says so when main can't answer at start, instead of a blank window", async () => {
    stubApi({})
    render(<App />)
    expect((await screen.findByRole("alert")).textContent).toMatch(/didn’t start/)
  })

  it("lists the project's problems with the scenes", async () => {
    stubApi({
      "app:status": () =>
        status({
          hasKey: true,
          project: {
            ...project,
            scenes: [{ id: "gone", title: "gone", status: "missing" }],
            problems: ["gone: in the sequence, but its folder is missing"],
          },
        }),
    })
    render(<App />)
    const list = await screen.findByRole("list", { name: "Problems" })
    expect(list.textContent).toMatch(/folder is missing/)
    expect(screen.getByRole("button", { name: /gone/ }).textContent).toMatch(/Folder missing/)
  })

  it("sends an address without a scheme to main (no browser check of its own)", async () => {
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true }),
      "project:create": () => status({ hasKey: true, error: "App address: Invalid URL" }),
    })
    render(<App />)
    const create = await screen.findByRole("button", { name: "Create project…" })
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Acme" } })
    fireEvent.change(screen.getByLabelText("App address"), { target: { value: "app.acme.com" } })
    fireEvent.click(create)
    expect((await screen.findByRole("alert")).textContent).toMatch(/App address/)
    expect(invoke).toHaveBeenCalledWith("project:create", { name: "Acme", url: "app.acme.com" })
  })

  it("starts another project's stage fresh (no selection carried over)", async () => {
    const { push } = stubApi({ "app:status": () => status({ hasKey: true, project }) })
    render(<App />)
    const strip = await screen.findByRole("region", { name: "Scenes" })
    fireEvent.click(within(strip).getAllByRole("button")[0]!)
    expect(within(strip).getAllByRole("button")[0]?.getAttribute("aria-pressed")).toBe("true")
    act(() =>
      push("status", status({ hasKey: true, project: { ...project, dir: "/tmp/other.kiframe" } })),
    )
    const again = await screen.findByRole("region", { name: "Scenes" })
    expect(within(again).getAllByRole("button")[0]?.getAttribute("aria-pressed")).toBe("false")
  })
})
