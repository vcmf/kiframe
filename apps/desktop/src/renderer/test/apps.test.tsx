// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ProjectView } from "../../shared/ipc.ts"
import { App } from "../src/app.tsx"
import { useChat } from "../src/chat-store.ts"
import { useApp } from "../src/store.ts"
import { status, stubApi } from "./stub-api.ts"

// B5: the project's apps, one removed, and the scenes that used it.
const project: ProjectView = {
  session: "s1",
  name: "Demo",
  dir: "/tmp/demo.kiframe",
  apps: [
    { name: "app", kind: "web", origin: "https://app.test" },
    { name: "docs", kind: "web", origin: "https://docs.test" },
  ],
  scenes: [
    { id: "install", title: "Install", status: "recorded", take: "k1", removedApps: ["auth"] },
    { id: "tour", title: "Tour", status: "grounded" },
  ],
  problems: [],
}

afterEach(() => {
  cleanup()
  useApp.setState({ status: null, busy: null, dismissed: null })
  useChat.setState({ items: [], running: false, model: "", frame: null, refused: null })
})

describe("the project's apps", () => {
  it("lists each app with its origin, removes any but the first (main asks, naming the scenes)", async () => {
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "apps:remove": () => null,
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /app\.test/ }))
    const panel = screen.getByRole("dialog", { name: "Apps" })
    const list = within(panel).getByRole("list", { name: "The project's apps" })
    expect(list.textContent).toContain("https://docs.test")
    expect(within(list).queryByRole("button", { name: "Remove app" })).toBeNull()
    expect(within(list).getByText("Where scenes start")).toBeTruthy()
    fireEvent.click(within(list).getByRole("button", { name: "Remove docs" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith("apps:remove", {
      session: "s1",
      name: "docs",
      identity: "https://docs.test",
    })
  })

  it("never removes an app while the agent works", async () => {
    stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "chat:state": () => ({ items: [], running: true, model: "", frame: null }),
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /app\.test/ }))
    await act(async () => {
      await Promise.resolve()
    })
    const panel = screen.getByRole("dialog", { name: "Apps" })
    expect(within(panel).getByRole("button", { name: "Remove docs" })).toHaveProperty(
      "disabled",
      true,
    )
  })

  it("marks a scene that uses a removed app, and asks the agent to rework it", async () => {
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "chat:send": () => null,
    })
    render(<App />)
    const strip = await screen.findByRole("region", { name: "Scenes" })
    expect(within(strip).getByText("Uses an app not in the project: auth")).toBeTruthy()
    // Its own status stays said: the recording still plays.
    expect(within(strip).getByText("Recorded")).toBeTruthy()
    fireEvent.click(within(strip).getByRole("button", { name: "Rework without it" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith(
      "chat:send",
      expect.stringMatching(/^Rework the scene “Install” \(install\) without the app "auth"/),
    )
    act(() => useChat.setState({ running: true }))
    expect(within(strip).getByRole("button", { name: "Rework without it" })).toHaveProperty(
      "disabled",
      true,
    )
  })
})

// PR 3b: a desktop app added from the panel (main picks, inspects, tries; the window holds a token).
describe("adding a desktop app", () => {
  const withDesktop: ProjectView = {
    ...project,
    apps: [...project.apps, { name: "notes", kind: "electron", bundleId: "com.example.Notes" }],
  }
  const card = {
    token: "6a1c6c1e-0f0b-4d5e-9a3b-2c1d0e9f8a7b",
    name: "Slack",
    bundleId: "com.tinyspeck.slackmacgap",
    version: "4.41",
    electron: "44.4.5",
    signer: { kind: "team" as const, team: "BQR82RBBHL" },
    existing: undefined,
    opens: undefined,
  }

  it("shows each desktop app's status on this Mac (nothing launched to know it)", async () => {
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project: withDesktop }),
      "apps:desktop-status": () => ({
        apps: {
          notes: { status: "allow", why: "approved for another project: allow it in this one" },
        },
        problem: null,
      }),
      "apps:desktop-cancel": () => undefined,
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /app\.test/ }))
    const panel = screen.getByRole("dialog", { name: "Apps" })
    expect(await within(panel).findByText(/approved for another project/)).toBeTruthy()
    expect(invoke).toHaveBeenCalledWith("apps:desktop-status", { session: "s1" })
  })

  it("picks, checks, allows a wrapper's site, then adds: never sending a path or a site", async () => {
    let checks = 0
    const { invoke } = stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "apps:desktop-pick": () => ({ card }),
      "apps:desktop-check": () =>
        checks++ === 0 ? { site: "https://app.slack.com" } : { ok: true },
      "apps:desktop-add": () => null,
      "apps:desktop-cancel": () => undefined,
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /app\.test/ }))
    const panel = screen.getByRole("dialog", { name: "Apps" })
    fireEvent.click(within(panel).getByRole("button", { name: "Add desktop app…" }))
    const adding = await within(panel).findByRole("region", { name: "Adding Slack" })
    expect(adding.textContent).toContain("signed by developer BQR82RBBHL")
    expect(within(adding).queryByRole("button", { name: "Add Slack" })).toBeNull()
    fireEvent.click(within(adding).getByRole("button", { name: "Check" }))
    fireEvent.click(
      await within(adding).findByRole("button", {
        name: "Allow https://app.slack.com and check again",
      }),
    )
    fireEvent.click(await within(adding).findByRole("button", { name: "Add Slack" }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith("apps:desktop-check", {
      session: "s1",
      token: card.token,
      allowSite: false,
    })
    expect(invoke).toHaveBeenCalledWith("apps:desktop-check", {
      session: "s1",
      token: card.token,
      allowSite: true,
    })
    expect(invoke).toHaveBeenCalledWith("apps:desktop-add", { session: "s1", token: card.token })
    // The window named no path and no site: only its session, the token and a yes.
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/Applications|slack\.com"/)
  })

  it("says why an app can't be added, and offers nothing off macOS", async () => {
    stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "apps:desktop-pick": () => ({
        refused: "that isn't an Electron app: Kiframe drives Electron apps only",
      }),
      "apps:desktop-cancel": () => undefined,
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /app\.test/ }))
    const panel = screen.getByRole("dialog", { name: "Apps" })
    fireEvent.click(within(panel).getByRole("button", { name: "Add desktop app…" }))
    expect((await within(panel).findByRole("alert")).textContent).toMatch(/Electron apps only/)
    cleanup()
    window.kiframe = { ...window.kiframe, platform: "linux" }
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /app\.test/ }))
    expect(screen.queryByRole("button", { name: "Add desktop app…" })).toBeNull()
  })

  it("shows what a project that names the app opens with it, before it's allowed", async () => {
    stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "apps:desktop-pick": () => ({
        card: {
          ...card,
          existing: "slack",
          opens: { args: ["files/vault"], origins: ["https://evil.example"] },
        },
      }),
      "apps:desktop-cancel": () => undefined,
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /app\.test/ }))
    const panel = screen.getByRole("dialog", { name: "Apps" })
    fireEvent.click(within(panel).getByRole("button", { name: "Add desktop app…" }))
    const adding = await within(panel).findByRole("region", { name: "Adding Slack" })
    expect(adding.textContent).toContain("the site https://evil.example as its own")
    expect(adding.textContent).toContain("files/vault (not opened by the check)")
  })

  it("never shows a check's answer on a card picked after it was given up", async () => {
    let answer: (v: unknown) => void = () => undefined
    let picks = 0
    stubApi({
      "app:status": () => status({ hasKey: true, project }),
      "apps:desktop-pick": () => ({
        card:
          picks++ === 0
            ? card
            : { ...card, token: "7b2d6d2f-1a1c-4e6f-8b4c-3d2e1f0a9b8c", name: "Notion" },
      }),
      "apps:desktop-check": () => new Promise((resolve) => (answer = resolve)) as never,
      "apps:desktop-cancel": () => undefined,
    })
    render(<App />)
    fireEvent.click(await screen.findByRole("button", { name: /app\.test/ }))
    const panel = screen.getByRole("dialog", { name: "Apps" })
    fireEvent.click(within(panel).getByRole("button", { name: "Add desktop app…" }))
    const slack = await within(panel).findByRole("region", { name: "Adding Slack" })
    fireEvent.click(within(slack).getByRole("button", { name: "Check" }))
    fireEvent.click(within(slack).getByRole("button", { name: "Cancel" }))
    fireEvent.click(within(panel).getByRole("button", { name: "Add desktop app…" }))
    const notion = await within(panel).findByRole("region", { name: "Adding Notion" })
    await act(async () => {
      answer({ ok: true })
      await Promise.resolve()
    })
    expect(within(notion).queryByRole("status")).toBeNull()
    expect(within(notion).queryByRole("button", { name: "Add Notion" })).toBeNull()
  })
})
