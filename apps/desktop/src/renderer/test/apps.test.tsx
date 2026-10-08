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
