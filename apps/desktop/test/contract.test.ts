import { describe, expect, it } from "vitest"
import { EVENT_CHANNELS, INVOKE_CHANNELS } from "../src/shared/channels.ts"
import { invokeArgs } from "../src/shared/ipc.ts"

describe("the IPC contract", () => {
  it("validates every channel's arguments (the preload allows exactly these)", () => {
    expect(Object.keys(invokeArgs).sort()).toEqual([...INVOKE_CHANNELS].sort())
    expect([...EVENT_CHANNELS].sort()).toEqual([
      "chat:item",
      "chat:running",
      "live:frame",
      "status",
    ])
  })

  // The address itself is checked in main by the project's rule (test/project.test.ts, targetUrl).
  it("refuses what the window shouldn't send", () => {
    const create = invokeArgs["project:create"]
    expect(create.safeParse([{ name: "Demo", url: "https://app.test" }]).success).toBe(true)
    for (const bad of [
      [{ name: "Demo", url: "" }],
      [{ name: "", url: "https://app.test" }],
      [{ name: "Demo", url: "https://app.test", dir: "/etc" }],
      [],
      [{ name: "Demo", url: "https://app.test" }, "extra"],
    ]) {
      expect(create.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(invokeArgs["key:set"].safeParse([""]).success).toBe(false)
    expect(invokeArgs["key:set"].safeParse(["x".repeat(513)]).success).toBe(false)
    expect(invokeArgs["project:open"].safeParse(["/etc"]).success).toBe(false)
    expect(invokeArgs["chat:send"].safeParse(["  "]).success).toBe(false)
    expect(invokeArgs["chat:send"].safeParse(["x".repeat(20_001)]).success).toBe(false)
    expect(invokeArgs["chat:answer"].safeParse(["request-1", true]).success).toBe(true)
    // A secret is added for an app by its name (main finds its origin): never an origin.
    const add = invokeArgs["secrets:add"]
    const form = { session: "s1", app: "docs", name: "a.b", kind: "password", value: "v" }
    expect(add.safeParse([form]).success).toBe(true)
    expect(add.safeParse([{ ...form, origin: "https://evil.test" }]).success).toBe(false)
    expect(add.safeParse([{ ...form, app: "https://evil.test" }]).success).toBe(false)
    expect(add.safeParse([{ ...form, app: "__proto__" }]).success).toBe(false)
    expect(
      invokeArgs["secrets:remove"].safeParse([{ session: "s1", app: "docs", name: "a.b" }]).success,
    ).toBe(true)
    expect(invokeArgs["secrets:remove"].safeParse(["a.b"]).success).toBe(false)
    expect(invokeArgs["chat:answer"].safeParse(["request-1", "the demo one"]).success).toBe(true)
    expect(invokeArgs["chat:answer"].safeParse(["request-1", { approve: true }]).success).toBe(
      false,
    )
    expect(invokeArgs["chat:answer"].safeParse(["x".repeat(65), true]).success).toBe(false)
  })
})
