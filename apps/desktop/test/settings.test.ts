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

  it("reads the keychain once (main is its only writer)", async () => {
    const backend = memoryBackend()
    let reads = 0
    const get = backend.get.bind(backend)
    backend.get = (name) => {
      reads += 1
      return get(name)
    }
    const keys = new KeyStore(backend)
    await keys.hasKey()
    await keys.hasKey()
    await keys.set("sk-or-1")
    expect(await keys.hasKey()).toBe(true)
    await keys.clear()
    expect(await keys.hasKey()).toBe(false)
    expect(reads).toBe(1)
  })

  it("never caches a read that a write overlapped", async () => {
    const backend = memoryBackend()
    let release: () => void = () => undefined
    const get = backend.get.bind(backend)
    backend.get = async (name) => {
      const value = await get(name)
      await new Promise<void>((r) => (release = r))
      return value
    }
    const keys = new KeyStore(backend)
    const reading = keys.hasKey()
    await keys.set("sk-or-1")
    release()
    await reading
    expect(await keys.hasKey()).toBe(true)
  })
})
