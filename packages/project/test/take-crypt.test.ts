import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { decrypt, encrypt, encryptFile, isEncrypted, readTakeFileAsync } from "../src/index.ts"

describe("a take's files at rest", () => {
  const key = randomBytes(32)
  const plain = Buffer.from("frames and events, unblurred")

  it("encrypts and decrypts with the store's key, a fresh IV each time", () => {
    const a = encrypt(plain, key)
    expect(isEncrypted(a)).toBe(true)
    expect(a.includes(plain)).toBe(false)
    expect(encrypt(plain, key).equals(a)).toBe(false)
    expect(decrypt(a, key).equals(plain)).toBe(true)
  })

  it("refuses another key and a changed file (never wrong bytes)", () => {
    const sealed = encrypt(plain, key)
    expect(() => decrypt(sealed, randomBytes(32))).toThrow(
      /don't open with this computer's take key/,
    )
    const changed = Buffer.from(sealed)
    changed[changed.length - 20] = (changed[changed.length - 20] ?? 0) ^ 1
    expect(() => decrypt(changed, key)).toThrow(/don't open/)
  })

  it("encrypts a file in place once, and reads plain files (takes from before) as they are", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-crypt-"))
    const file = join(dir, "events.jsonl")
    writeFileSync(file, plain)
    expect((await readTakeFileAsync(file, { key: undefined })).equals(plain)).toBe(true)
    await encryptFile(file, key, "k1/events.jsonl")
    const once = readFileSync(file)
    await encryptFile(file, key, "k1/events.jsonl")
    expect(readFileSync(file).equals(once)).toBe(true)
    const read = await readTakeFileAsync(file, { key, bound: "k1/events.jsonl" })
    expect(read.equals(plain)).toBe(true)
    await expect(readTakeFileAsync(file, { key: undefined })).rejects.toThrow(/no take key/)
    // Bound to its take and its name: as another take's, or another file, it doesn't open.
    await expect(readTakeFileAsync(file, { key, bound: "k2/events.jsonl" })).rejects.toThrow(
      /another key, or changed/,
    )
    await expect(readTakeFileAsync(file, { key, bound: "k1/cursor.jsonl" })).rejects.toThrow(
      /another key, or changed/,
    )
  })
})
