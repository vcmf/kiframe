// The OpenRouter key, in the OS keychain under the app's own service: never one of a project's
// secrets (the agent lists those by name), never written to a file, never sent to the window.
import { randomBytes } from "node:crypto"
import type { SecretBackend } from "@kiframe/vault"

const ACCOUNT = "openrouter-api-key"
/** The take store's encryption key (hex), beside it under the app's own service. */
const TAKE_KEY_ACCOUNT = "take-store-key"

/**
 * The take store's key: the one in the keychain, else a new one, stored before it's used. One that
 * doesn't read as a key is never replaced (every take encrypted with it would be lost): said.
 */
export async function takeStoreKey(backend: SecretBackend): Promise<Uint8Array> {
  const stored = await backend.get(TAKE_KEY_ACCOUNT)
  if (stored !== undefined && stored !== "") {
    if (!/^[0-9a-f]{64}$/.test(stored)) {
      throw new Error("the take key in the keychain isn't one: takes can't be read or written")
    }
    return Buffer.from(stored, "hex")
  }
  const key = randomBytes(32)
  await backend.set(TAKE_KEY_ACCOUNT, key.toString("hex"))
  return key
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
