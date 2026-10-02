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
    { id: "intro", title: "Intro", kind: "card" as const, status: "card" as const },
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

  it("creates a project only with a name and an http(s) address", async () => {
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true }),
      "project:create": () => status({ hasKey: true, project }),
    })
    render(<App />)
    const create = await screen.findByRole("button", { name: "Create project…" })
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Acme" } })
    fireEvent.change(screen.getByLabelText("App address"), { target: { value: "ftp://x" } })
    expect(create).toHaveProperty("disabled", true)
    fireEvent.change(screen.getByLabelText("App address"), {
      target: { value: "https://app.acme.example" },
    })
    fireEvent.click(create)
    await screen.findByRole("region", { name: "Scenes" })
    expect(invoke).toHaveBeenCalledWith("project:create", {
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
})
