import type { Page } from "playwright"
import { describe, expect, it } from "vitest"
import type { LiveFrame } from "../src/shared/ipc.ts"
import { frameSize, LiveView } from "../src/main/live.ts"

/** A page whose screencast sends the frames the test asks for. */
function fakePage() {
  let onFrame: ((f: { data: Buffer }) => void) | undefined
  const asked: { size?: { width: number; height: number } }[] = []
  const page = {
    url: () => "http://app.test/projects?token=x",
    isClosed: () => false,
    viewportSize: () => ({ width: 1440, height: 900 }),
    screencast: {
      start: (o: {
        onFrame: (f: { data: Buffer }) => void
        size?: { width: number; height: number }
      }) => {
        onFrame = o.onFrame
        asked.push(o)
        return Promise.resolve()
      },
      stop: () => Promise.resolve(),
    },
    screenshot: () => Promise.resolve(Buffer.from("last")),
  }
  return {
    page: page as unknown as Page,
    frame: (text: string) => onFrame?.({ data: Buffer.from(text) }),
    asked,
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("the live view", () => {
  it("streams the page at its own size (never Playwright's 800×500 default)", async () => {
    const { page, asked } = fakePage()
    const live = new LiveView(
      () => page,
      () => undefined,
    )
    live.start()
    await wait(20)
    expect(asked[0]?.size).toEqual({ width: 1440, height: 900 })
    await live.stop()
  })

  it("caps a large page's frames, and never sends Playwright's 800×500 for a page with no viewport", () => {
    expect(frameSize({ width: 2560, height: 1440 })).toEqual({ width: 1600, height: 900 })
    expect(frameSize({ width: 1024, height: 680 })).toEqual({ width: 1024, height: 680 })
    expect(frameSize(null)).toEqual({ width: 1280, height: 800 })
  })

  it("never drops the last frame of a burst, sends a few a second, and the page's path only", async () => {
    const { page, frame } = fakePage()
    const sent: LiveFrame[] = []
    const live = new LiveView(
      () => page,
      (f) => sent.push(f),
    )
    live.start()
    await wait(20)
    frame("first")
    frame("middle")
    frame("settled")
    await wait(300)
    const texts = sent.map((f) => Buffer.from(f.jpeg, "base64").toString())
    expect(texts.at(-1)).toBe("settled")
    expect(texts.length).toBeLessThanOrEqual(2)
    expect(sent[0]?.path).toBe("/projects")
    await live.stop()
    // Its last frame: the page as it is at the end.
    expect(Buffer.from(sent.at(-1)!.jpeg, "base64").toString()).toBe("last")
  })
})
