// A take's files encrypted at rest (docs/OBJECT-MODEL.md §0.7): AES-256-GCM, a fresh IV per file,
// `magic | iv | ciphertext | tag`. A file without the magic is a take from before (plain). Apart
// from the store: readers that only need to tell an encrypted file (the exporter) load no runtime.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
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

/**
 * `bound`: what the bytes are (`<takeKey>/<file>`), authenticated with them: a file moved to
 * another take, or put in another's place, doesn't open.
 */
export function encrypt(plain: Uint8Array, key: Uint8Array, bound = ""): Buffer {
  return Buffer.concat(encryptParts(plain, key, bound))
}

/** An encrypted file's parts in order (written in turn: the body never copied into one buffer). */
function encryptParts(plain: Uint8Array, key: Uint8Array, bound: string): Buffer[] {
  checkKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(bound, "utf8"))
  const body = cipher.update(plain)
  const end = cipher.final()
  return [MAGIC, iv, body, end, cipher.getAuthTag()]
}

/** The plain bytes; throws on another key or a file changed since (its tag doesn't match). */
export function decrypt(bytes: Uint8Array, key: Uint8Array, bound = ""): Buffer {
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
  decipher.setAAD(Buffer.from(bound, "utf8"))
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
export async function encryptFile(path: string, key: Uint8Array, bound = ""): Promise<boolean> {
  if (await isEncryptedFile(path)) return false
  await encryptPlainFile(path, key, bound)
  return true
}

/** Encrypts a file known to be plain (its header just read): as `encryptFile`, without the check. */
export async function encryptPlainFile(path: string, key: Uint8Array, bound = ""): Promise<void> {
  const plain = await readFile(path)
  await writeAtomicAsync(path, encryptParts(plain, key, bound))
}

/** A key, or how to get it (asked only when a file read turns out encrypted). */
export type KeySource = Uint8Array | undefined | (() => Promise<Uint8Array | undefined>)

/** How a take's file is read: its key (or how to get it), its sealed take, what it is. */
export interface TakeFileReading {
  key: KeySource
  /** Its take was sealed: a file without the magic was changed, never plain. */
  sealed?: boolean
  /** What it is (`<takeKey>/<file>`): authenticated with it. */
  bound?: string
}

/**
 * A take file's plain bytes, read once without holding the thread (a take's frames are tens of
 * MB): decrypted when what was read is encrypted (the key asked then: a file sealed meanwhile is
 * read as it was, plain, or as it is, never judged then read changed); as it is when plain (a take
 * from before), unless its take was sealed (then it was changed: refused).
 */
export async function readTakeFileAsync(path: string, reading: TakeFileReading): Promise<Buffer> {
  const bytes = await readFile(path)
  if (!isEncrypted(bytes)) {
    if (reading.sealed === true) throw new Error(CHANGED)
    return bytes
  }
  const key = typeof reading.key === "function" ? await reading.key() : reading.key
  if (key === undefined) throw new Error("the take is encrypted: no take key here")
  return decrypt(bytes, key, reading.bound ?? "")
}

function checkKey(key: Uint8Array): void {
  if (key.length !== TAKE_KEY_BYTES) throw new Error(`a take key is ${TAKE_KEY_BYTES} bytes`)
}
