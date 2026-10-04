import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryBackend } from "@kiframe/vault"
import { describe, expect, it } from "vitest"
import { takeStoreKey } from "../src/main/settings.ts"

describe("the take store's key", () => {
  it("is made once and kept in the keychain; one that doesn't read is never replaced", async () => {
    const made = join(mkdtempSync(join(tmpdir(), "kiframe-key-")), "take-key-made")
    const backend = memoryBackend()
    const first = await takeStoreKey(backend, made)
    expect(first.length).toBe(32)
    expect(Buffer.from(await takeStoreKey(backend, made)).equals(Buffer.from(first))).toBe(true)
    backend.values.set("take-store-key", "not a key")
    await expect(takeStoreKey(backend, made)).rejects.toThrow(/isn't one/)
    expect(backend.values.get("take-store-key")).toBe("not a key")
  })

  it("is never made again over one that existed (a keychain saying 'none' wrongly)", async () => {
    const made = join(mkdtempSync(join(tmpdir(), "kiframe-key-")), "take-key-made")
    const backend = memoryBackend()
    await takeStoreKey(backend, made)
    // Locked, or a backend answering "no entry": refused, nothing written.
    backend.values.delete("take-store-key")
    await expect(takeStoreKey(backend, made)).rejects.toThrow(/missing from the keychain/)
    expect(backend.values.has("take-store-key")).toBe(false)
  })

  it("marks a key made before the marker, makes none without a marker it can write, and keeps no marker for a keychain in memory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-key-"))
    // A key with no marker (made before it): marked on its first read.
    const backend = memoryBackend()
    backend.values.set("take-store-key", "ab".repeat(32))
    await takeStoreKey(backend, join(dir, "take-key-made"))
    expect(existsSync(join(dir, "take-key-made"))).toBe(true)
    // A marker that can't be written (its folder is a file): no key is made.
    writeFileSync(join(dir, "blocked"), "")
    const fresh = memoryBackend()
    await expect(takeStoreKey(fresh, join(dir, "blocked", "take-key-made"))).rejects.toThrow()
    expect(fresh.values.has("take-store-key")).toBe(false)
    // A keychain in memory (tests): no marker, so a new launch makes its key again.
    expect((await takeStoreKey(memoryBackend(), undefined)).length).toBe(32)
    expect((await takeStoreKey(memoryBackend(), undefined)).length).toBe(32)
  })
})
