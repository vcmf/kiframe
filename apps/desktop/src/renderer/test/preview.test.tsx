// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Preview } from "../../shared/ipc.ts"
import type { ProjectView } from "../../shared/ipc.ts"
import { useChat } from "../src/chat-store.ts"
import { clock, PreviewPlayer } from "../src/components/preview-player.tsx"
import { Stage } from "../src/components/stage.tsx"
import { stubApi } from "./stub-api.ts"

// The compositor's player decodes with WebCodecs (a real browser: compositor's player.test.ts);
// here a stand-in with its API, to test what the window does with it.
const fake = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const player = {
    duration: 12_000,
    time: 0,
    playing: false,
    style: { width: 1920, height: 1080 },
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    play: vi.fn(() => {
      player.playing = true
      listeners.forEach((l) => l())
    }),
    pause: vi.fn(() => {
      player.playing = false
      listeners.forEach((l) => l())
    }),
    seek: vi.fn((t: number) => {
      player.time = t
      listeners.forEach((l) => l())
      return Promise.resolve()
    }),
    dispose: vi.fn(),
  }
  return { player, load: vi.fn(() => Promise.resolve(player)) }
})
vi.mock("@kiframe/compositor", () => ({
  Player: { load: fake.load },
  flatten: (style: object, format: object) => ({ ...style, ...format }),
}))

afterEach(cleanup)

const ready = {
  ok: true,
  sceneId: "tour",
  title: "Tour",
  composition: {},
  scenario: {},
  take: { meta: {}, events: [], cursor: [] },
  video: new Uint8Array([1, 2, 3]),
  style: {},
  format: { width: 1920, height: 1080, fps: 30 },
} as unknown as Preview

describe("the preview", () => {
  it("says why a scene can't play", async () => {
    stubApi({ "preview:open": () => ({ ok: false, why: "Not filmed yet: record it." }) })
    render(<PreviewPlayer sceneId="tour" take={undefined} version={undefined} />)
    expect((await screen.findByRole("status")).textContent).toBe("Not filmed yet: record it.")
  })

  it("plays a filmed scene: play, pause, the position and the time", async () => {
    const { invoke } = stubApi({ "preview:open": () => ready })
    render(<PreviewPlayer sceneId="tour" take="k1" version="v1" />)
    const play = await screen.findByRole("button", { name: "Play" })
    expect(invoke).toHaveBeenCalledWith("preview:open", "tour")
    expect(fake.load).toHaveBeenCalledTimes(1)
    expect(screen.getByText("0:00 / 0:12")).toBeTruthy()
    fireEvent.click(play)
    expect(fake.player.play).toHaveBeenCalled()
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }))
    expect(fake.player.pause).toHaveBeenCalled()
    await act(async () => {
      fireEvent.change(screen.getByRole("slider", { name: "Position" }), {
        target: { value: "6000" },
      })
      await Promise.resolve()
    })
    expect(fake.player.seek).toHaveBeenCalledWith(6000)
    await waitFor(() => expect(screen.getByText("0:06 / 0:12")).toBeTruthy())
  })

  it("lets go of the player when the scene changes", async () => {
    stubApi({ "preview:open": () => ready })
    const { rerender } = render(<PreviewPlayer sceneId="tour" take="k1" version="v1" />)
    await screen.findByRole("button", { name: "Play" })
    // Counted from here (the mock is shared with the tests before).
    fake.player.dispose.mockClear()
    rerender(<PreviewPlayer sceneId="tour" take="k2" version="v1" />)
    await waitFor(() => expect(fake.player.dispose).toHaveBeenCalledTimes(1))
  })

  it("shows a scene a run filmed once its new take arrives, after the run ended", async () => {
    stubApi({ "preview:open": () => ({ ok: false, why: "Not filmed yet: record it." }) })
    const project = (take?: string): ProjectView => ({
      session: "s1",
      name: "Demo",
      dir: "/tmp/demo",
      url: "https://app.example",
      problems: [],
      scenes: [
        { id: "intro", title: "Intro", status: "grounded" },
        {
          id: "tour",
          title: "Tour",
          status: take === undefined ? "grounded" : "recorded",
          ...(take !== undefined && { take }),
        },
      ],
    })
    const { rerender } = render(<Stage project={project()} />)
    act(() => useChat.setState({ running: true }))
    expect(screen.getByRole("tab", { name: /Live app/ }).getAttribute("aria-selected")).toBe("true")
    // The run's end comes first, the project with the new take a moment later.
    act(() => useChat.setState({ running: false }))
    rerender(<Stage project={project("k1")} />)
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Preview/ }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    )
    expect(screen.getByRole("button", { name: /Tour/ }).getAttribute("aria-pressed")).toBe("true")
  })

  it("plays the scene again once it's edited (same take, another composition)", async () => {
    stubApi({ "preview:open": () => ready })
    const { rerender } = render(<PreviewPlayer sceneId="tour" take="k1" version="v1" />)
    await screen.findByRole("button", { name: "Play" })
    fake.load.mockClear()
    rerender(<PreviewPlayer sceneId="tour" take="k1" version="v2" />)
    await waitFor(() => expect(fake.load).toHaveBeenCalledTimes(1))
  })

  it("shows the scene a run filmed when its take arrives during the run, and leaves the user's tab alone", async () => {
    stubApi({ "preview:open": () => ({ ok: false, why: "Not filmed yet: record it." }) })
    const project = (take?: string, title = "Tour"): ProjectView => ({
      session: "s1",
      name: "Demo",
      dir: "/tmp/demo",
      url: "https://app.example",
      problems: [],
      scenes: [
        { id: "intro", title: "Intro", status: "recorded", take: "k0" },
        {
          id: "tour",
          title,
          status: take === undefined ? "grounded" : "recorded",
          ...(take !== undefined && { take }),
        },
      ],
    })
    const tab = (name: RegExp) => screen.getByRole("tab", { name }).getAttribute("aria-selected")
    const { rerender } = render(<Stage project={project()} />)
    act(() => useChat.setState({ running: true }))
    expect(tab(/Live app/)).toBe("true")
    // The user picks Preview mid-run: the agent saving a scene doesn't take it back.
    fireEvent.click(screen.getByRole("tab", { name: /Preview/ }))
    rerender(<Stage project={project(undefined, "Tour, saved")} />)
    expect(tab(/Preview/)).toBe("true")
    fireEvent.click(screen.getByRole("tab", { name: /Live app/ }))
    // The take is saved while the run still goes; the run ends after.
    rerender(<Stage project={project("k1")} />)
    act(() => useChat.setState({ running: false }))
    await waitFor(() => expect(tab(/Preview/)).toBe("true"))
    expect(screen.getByRole("button", { name: /Tour/ }).getAttribute("aria-pressed")).toBe("true")
  })

  it("says times as m:ss", () => {
    expect([0, 999, 61_000, 600_500].map(clock)).toEqual(["0:00", "0:00", "1:01", "10:00"])
  })
})
