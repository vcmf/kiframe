import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { decrypt, encrypt, encryptFile, isEncrypted, readTakeFile } from "../src/index.ts"

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

  it("encrypts a file in place once, and reads plain files (takes from before) as they are", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-crypt-"))
    const file = join(dir, "events.jsonl")
    writeFileSync(file, plain)
    expect(readTakeFile(file, undefined).equals(plain)).toBe(true)
    encryptFile(file, key)
    const once = readFileSync(file)
    encryptFile(file, key)
    expect(readFileSync(file).equals(once)).toBe(true)
    expect(readTakeFile(file, key).equals(plain)).toBe(true)
    expect(() => readTakeFile(file, undefined)).toThrow(/encrypted: no take key/)
  })
})
