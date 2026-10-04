// The OpenRouter key, in the OS keychain under the app's own service: never one of a project's
// secrets (the agent lists those by name), never written to a file, never sent to the window.
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { TAKE_KEY_BYTES } from "@kiframe/project/take-crypt"
import type { SecretBackend } from "@kiframe/vault"

const ACCOUNT = "openrouter-api-key"
/** The take store's encryption key (hex), beside it under the app's own service. */
const TAKE_KEY_ACCOUNT = "take-store-key"

/**
 * The take store's key: the one in the keychain, else a new one, stored before it's used. A key is
 * made once per store: `made` (a file in app data) says one was, and then a keychain that has
 * none (locked, a backend saying "no entry" wrongly) is refused, never answered with a new key
 * over the old (every take encrypted with it would be lost). One that doesn't read as a key: said.
 */
export async function takeStoreKey(
  backend: SecretBackend,
  /** The marker's path; undefined: none (a keychain that lives in memory, tests). */
  made: string | undefined,
): Promise<Uint8Array> {
  const stored = await backend.get(TAKE_KEY_ACCOUNT)
  if (stored !== undefined && stored !== "") {
    if (!new RegExp(`^[0-9a-f]{${TAKE_KEY_BYTES * 2}}$`).test(stored)) {
      throw new Error("the take key in the keychain isn't one: takes can't be read or written")
    }
    // A key without its marker (made before it, app data restored): marked now (best effort).
    if (made !== undefined && !existsSync(made)) markMade(made, false)
    return Buffer.from(stored, "hex")
  }
  if (made !== undefined && existsSync(made)) {
    throw new Error(
      "the take key is missing from the keychain (locked, or removed): recordings can't be read or made until it's back",
    )
  }
  // Marked before it's stored (a marker that can't be written: no key, said; never a key made
  // without its marker, which could later be made again over).
  if (made !== undefined) markMade(made, true)
  const key = randomBytes(TAKE_KEY_BYTES)
  await backend.set(TAKE_KEY_ACCOUNT, key.toString("hex"))
  return key
}

function markMade(made: string, required: boolean): void {
  try {
    mkdirSync(dirname(made), { recursive: true, mode: 0o700 })
    writeFileSync(made, `${new Date().toISOString()}\n`, { mode: 0o600 })
  } catch (error) {
    if (required) throw error
  }
}

export class KeyStore {
  readonly #backend: SecretBackend
  /** Whether a key is set, once read (main is the only writer: kept in step by set and clear). */
  #has: boolean | undefined
  /** Bumped by every write: a read that a write overlapped never caches its answer. */
  #writes = 0

  constructor(backend: SecretBackend) {
    this.#backend = backend
  }

  async hasKey(): Promise<boolean> {
    if (this.#has !== undefined) return this.#has
    const writes = this.#writes
    const has = ((await this.#backend.get(ACCOUNT)) ?? "") !== ""
    if (writes !== this.#writes) return this.#has ?? has
    this.#has = has
    return has
  }

  /** The key, for main's own use (the model client); undefined when none is set. */
  async key(): Promise<string | undefined> {
    const value = await this.#backend.get(ACCOUNT)
    return value === "" ? undefined : value
  }

  async set(key: string): Promise<void> {
    this.#writes += 1
    await this.#backend.set(ACCOUNT, key.trim())
    this.#has = key.trim() !== ""
  }

  async clear(): Promise<void> {
    this.#writes += 1
    await this.#backend.delete(ACCOUNT)
    this.#has = false
  }
}
