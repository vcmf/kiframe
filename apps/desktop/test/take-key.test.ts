import { memoryBackend } from "@kiframe/vault"
import { describe, expect, it } from "vitest"
import { takeStoreKey } from "../src/main/settings.ts"

describe("the take store's key", () => {
  it("is made once and kept in the keychain; one that doesn't read is never replaced", async () => {
    const backend = memoryBackend()
    const first = await takeStoreKey(backend)
    expect(first.length).toBe(32)
    expect(Buffer.from(await takeStoreKey(backend)).equals(Buffer.from(first))).toBe(true)
    backend.values.set("take-store-key", "not a key")
    await expect(takeStoreKey(backend)).rejects.toThrow(/isn't one/)
    expect(backend.values.get("take-store-key")).toBe("not a key")
  })
})
