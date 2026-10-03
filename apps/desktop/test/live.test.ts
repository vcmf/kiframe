import type { Page } from "playwright"
import { describe, expect, it } from "vitest"
import type { LiveFrame } from "../src/shared/ipc.ts"
import { LiveView } from "../src/main/live.ts"

/** A page whose screencast sends the frames the test asks for. */
function fakePage() {
  let onFrame: ((f: { data: Buffer }) => void) | undefined
  const page = {
    url: () => "http://app.test/projects?token=x",
    isClosed: () => false,
    screencast: {
      start: (o: { onFrame: (f: { data: Buffer }) => void }) => {
        onFrame = o.onFrame
        return Promise.resolve()
      },
      stop: () => Promise.resolve(),
    },
    screenshot: () => Promise.resolve(Buffer.from("last")),
  }
  return {
    page: page as unknown as Page,
    frame: (text: string) => onFrame?.({ data: Buffer.from(text) }),
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("the live view", () => {
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
