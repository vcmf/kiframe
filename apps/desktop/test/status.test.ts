import { describe, expect, it } from "vitest"
import { readStatus } from "../src/main/status.ts"

describe("the window's status", () => {
  it("says a keychain that can't be read, without keeping it once it can", async () => {
    let locked = true
    const hasKey = () => (locked ? Promise.reject(new Error("locked")) : Promise.resolve(true))
    expect(await readStatus(hasKey, null, null)).toEqual({
      hasKey: false,
      project: null,
      error: "couldn't read the system keychain: locked",
    })
    locked = false
    expect(await readStatus(hasKey, null, null)).toEqual({
      hasKey: true,
      project: null,
      error: null,
    })
  })

  it("keeps the action's error beside a keychain failure (never one hiding the other)", async () => {
    const failing = () => Promise.reject(new Error("locked"))
    expect(
      (await readStatus(failing, null, "couldn't clean up old recordings: EACCES")).error,
    ).toBe("couldn't clean up old recordings: EACCES; couldn't read the system keychain: locked")
    expect((await readStatus(() => Promise.resolve(true), null, "x")).error).toBe("x")
  })
})
