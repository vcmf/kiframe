import { memoryBackend } from "@kiframe/vault"
import { describe, expect, it } from "vitest"
import { KeyStore } from "../src/main/settings.ts"

describe("the OpenRouter key", () => {
  it("is kept trimmed under the app's own entry, and cleared", async () => {
    const backend = memoryBackend()
    const keys = new KeyStore(backend)
    expect(await keys.hasKey()).toBe(false)
    await keys.set("  sk-or-123  ")
    expect(await keys.hasKey()).toBe(true)
    expect(await keys.key()).toBe("sk-or-123")
    expect([...backend.values.keys()]).toEqual(["openrouter-api-key"])
    await keys.clear()
    expect(await keys.hasKey()).toBe(false)
    expect(await keys.key()).toBeUndefined()
  })

  it("treats an empty entry as no key", async () => {
    const backend = memoryBackend()
    backend.values.set("openrouter-api-key", "")
    expect(await new KeyStore(backend).hasKey()).toBe(false)
  })
})
