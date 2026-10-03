// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { AgentText } from "../src/components/markdown.tsx"
import { stubApi } from "./stub-api.ts"

afterEach(cleanup)

describe("the agent's answers", () => {
  it("render Markdown, never raw HTML", () => {
    stubApi({})
    const { container } = render(
      <AgentText
        text={
          "Done: **`tour`** is saved.\n\n- one\n- two\n\n<img src=x onerror=alert(1)><b>raw</b>"
        }
      />,
    )
    expect(container.querySelector("strong code")?.textContent).toBe("tour")
    expect(container.querySelectorAll("li")).toHaveLength(2)
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("b")).toBeNull()
    expect(container.textContent).not.toContain("**")
  })

  it("renders a nested list without blank lines (a list item's own whitespace stays collapsed)", () => {
    stubApi({})
    const { container } = render(<AgentText text={"- one\n  - nested a\n  - nested b"} />)
    expect(container.querySelectorAll("li")).toHaveLength(3)
    for (const li of container.querySelectorAll("li")) expect(li.style.whiteSpace).toBe("")
  })

  it("keeps the agent's single line breaks", () => {
    stubApi({})
    const { container } = render(<AgentText text={"Saved the scene.\nRecording now."} />)
    const p = container.querySelector("p")
    expect(p?.textContent).toBe("Saved the scene.\nRecording now.")
    // Kept on screen by the paragraph's own white-space.
    expect(p?.style.whiteSpace).toBe("pre-line")
  })

  it("opens an https link in the user's browser (never in the window), nothing else", () => {
    const { invoke } = stubApi({ "external:open": () => undefined })
    render(
      <AgentText
        text={"See [the docs](https://minmux.dev/docs) or [this](javascript:alert(1))."}
      />,
    )
    // Where it really goes, always shown.
    expect(screen.getByText("the docs").closest("a")?.textContent).toBe("the docs (minmux.dev)")
    fireEvent.click(screen.getByText("the docs"))
    expect(invoke).toHaveBeenCalledWith("external:open", "https://minmux.dev/docs")
    fireEvent.click(screen.getByText("this"))
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
