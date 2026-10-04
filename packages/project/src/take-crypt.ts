// A take's files encrypted at rest (docs/OBJECT-MODEL.md §0.7): AES-256-GCM, a fresh IV per file,
// `magic | iv | ciphertext | tag`. A file without the magic is a take from before (plain). Apart
// from the store: readers that only need to tell an encrypted file (the exporter) load no runtime.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"

const MAGIC = Buffer.from("KFT\u0001", "latin1")
const IV_BYTES = 12
const TAG_BYTES = 16

/** Bytes of a key the store encrypts with. */
export const TAKE_KEY_BYTES = 32

/** Whether a file's bytes are an encrypted take file. */
export function isEncrypted(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length && MAGIC.equals(Buffer.from(bytes.subarray(0, MAGIC.length)))
}

export function encrypt(plain: Uint8Array, key: Uint8Array): Buffer {
  checkKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()])
}

/** The plain bytes; throws on another key or a file changed since (its tag doesn't match). */
export function decrypt(bytes: Uint8Array, key: Uint8Array): Buffer {
  checkKey(key)
  if (!isEncrypted(bytes) || bytes.length < MAGIC.length + IV_BYTES + TAG_BYTES) {
    throw new Error("not an encrypted take file")
  }
  const buf = Buffer.from(bytes)
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
  const tag = buf.subarray(buf.length - TAG_BYTES)
  const body = buf.subarray(MAGIC.length + IV_BYTES, buf.length - TAG_BYTES)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error(
      "the take's files don't open with this computer's take key (another key, or changed)",
    )
  }
}

/** Encrypts a file in place (written whole next to it, then swapped in; already encrypted: kept). */
export function encryptFile(path: string, key: Uint8Array): void {
  const plain = readFileSync(path)
  if (isEncrypted(plain)) return
  const tmp = `${path}.enc-tmp`
  writeFileSync(tmp, encrypt(plain, key), { mode: 0o600 })
  renameSync(tmp, path)
}

/** A file's plain bytes: decrypted when encrypted (a key needed), as they are when plain. */
export function readTakeFile(path: string, key: Uint8Array | undefined): Buffer {
  const bytes = readFileSync(path)
  if (!isEncrypted(bytes)) return bytes
  if (key === undefined) throw new Error("the take is encrypted: no take key here")
  return decrypt(bytes, key)
}

function checkKey(key: Uint8Array): void {
  if (key.length !== TAKE_KEY_BYTES) throw new Error(`a take key is ${TAKE_KEY_BYTES} bytes`)
}
