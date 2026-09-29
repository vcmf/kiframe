import type { Page } from "playwright"
import { describe, expect, it } from "vitest"
import { boundedRead } from "../src/run/secrets.ts"

describe("boundedRead (SECRETS-DESIGN T2)", () => {
  it("drops a read that took too long, and holds only that page's next reads until it settles", async () => {
    const ctx = { stuckReads: new WeakMap<Page, number>() }
    const a = {} as Page
    const b = {} as Page
    let release: () => void = () => undefined
    const stuck = new Promise<string>((resolve) => {
      release = () => resolve("late")
    })
    expect(await boundedRead(ctx, a, () => stuck)).toBeUndefined()
    // A: unsure while its read is pending; B: read as usual.
    expect(await boundedRead(ctx, a, () => Promise.resolve("a"))).toBeUndefined()
    expect(await boundedRead(ctx, b, () => Promise.resolve("b"))).toBe("b")
    release()
    await stuck
    await new Promise((r) => setTimeout(r, 0))
    expect(await boundedRead(ctx, a, () => Promise.resolve("a"))).toBe("a")
  }, 10_000)
})
