import { mkdtempSync } from "node:fs"
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
})
