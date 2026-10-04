// A take's files encrypted at rest (docs/OBJECT-MODEL.md §0.7): AES-256-GCM, a fresh IV per file,
// `magic | iv | ciphertext | tag`. A file without the magic is a take from before (plain). Apart
// from the store: readers that only need to tell an encrypted file (the exporter) load no runtime.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { open, readFile } from "node:fs/promises"
import { writeAtomicAsync } from "./files.ts"

const MAGIC = Buffer.from("KFT\u0001", "latin1")
const IV_BYTES = 12
const TAG_BYTES = 16

const CHANGED =
  "the take's files don't open with this computer's take key (another key, or changed)"

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
  // One concatenation (GCM's final adds no bytes; the body isn't copied twice).
  const body = cipher.update(plain)
  const end = cipher.final()
  return Buffer.concat([MAGIC, iv, body, end, cipher.getAuthTag()])
}

/** The plain bytes; throws on another key or a file changed since (its tag doesn't match). */
export function decrypt(bytes: Uint8Array, key: Uint8Array): Buffer {
  checkKey(key)
  if (!isEncrypted(bytes) || bytes.length < MAGIC.length + IV_BYTES + TAG_BYTES) {
    throw new Error("not an encrypted take file")
  }
  // The bytes as they are (a copy of a take's frames would double what decrypting holds).
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
  const tag = buf.subarray(buf.length - TAG_BYTES)
  const body = buf.subarray(MAGIC.length + IV_BYTES, buf.length - TAG_BYTES)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  try {
    const out = decipher.update(body)
    const end = decipher.final()
    return end.length === 0 ? out : Buffer.concat([out, end])
  } catch {
    throw new Error(CHANGED)
  }
}

/** Whether a file is encrypted, from its first bytes only (never the whole file). */
export async function isEncryptedFile(path: string): Promise<boolean> {
  const file = await open(path, "r")
  try {
    const head = Buffer.alloc(MAGIC.length)
    const { bytesRead } = await file.read(head, 0, head.length, 0)
    return bytesRead === head.length && isEncrypted(head)
  } finally {
    await file.close()
  }
}

/**
 * Encrypts a file in place, without holding the thread: written whole and synced next to it, then
 * swapped in (a crash leaves the plain file or the encrypted one, never a torn one); one already
 * encrypted is known from its first bytes and kept. Whether it encrypted it.
 */
export async function encryptFile(path: string, key: Uint8Array): Promise<boolean> {
  if (await isEncryptedFile(path)) return false
  const plain = await readFile(path)
  await writeAtomicAsync(path, encrypt(plain, key))
  return true
}

/**
 * A file's plain bytes: decrypted when encrypted (a key needed), as they are when plain (a take
 * from before); in a sealed take (`sealed`), a file without the magic was changed: refused.
 */
function plainOf(bytes: Buffer, key: Uint8Array | undefined, sealed: boolean): Buffer {
  if (!isEncrypted(bytes)) {
    if (sealed) throw new Error(CHANGED)
    return bytes
  }
  if (key === undefined) throw new Error("the take is encrypted: no take key here")
  return decrypt(bytes, key)
}

/** A take file's plain bytes, read without holding the thread (a take's frames are tens of MB). */
export async function readTakeFileAsync(
  path: string,
  key: Uint8Array | undefined,
  sealed = false,
): Promise<Buffer> {
  return plainOf(await readFile(path), key, sealed)
}

/** A take file's plain bytes (a small one: events, cursor). */
export function readTakeFile(path: string, key: Uint8Array | undefined, sealed = false): Buffer {
  return plainOf(readFileSync(path), key, sealed)
}

function checkKey(key: Uint8Array): void {
  if (key.length !== TAKE_KEY_BYTES) throw new Error(`a take key is ${TAKE_KEY_BYTES} bytes`)
}
