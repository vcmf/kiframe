// The OpenRouter key, in the OS keychain under the app's own service: never one of a project's
// secrets (the agent lists those by name), never written to a file, never sent to the window.
import type { SecretBackend } from "@kiframe/vault"

const ACCOUNT = "openrouter-api-key"

export class KeyStore {
  readonly #backend: SecretBackend
  /** Whether a key is set, once read (main is the only writer: kept in step by set and clear). */
  #has: boolean | undefined

  constructor(backend: SecretBackend) {
    this.#backend = backend
  }

  async hasKey(): Promise<boolean> {
    this.#has ??= ((await this.#backend.get(ACCOUNT)) ?? "") !== ""
    return this.#has
  }

  /** The key, for main's own use (the model client); undefined when none is set. */
  async key(): Promise<string | undefined> {
    const value = await this.#backend.get(ACCOUNT)
    return value === "" ? undefined : value
  }

  async set(key: string): Promise<void> {
    await this.#backend.set(ACCOUNT, key.trim())
    this.#has = key.trim() !== ""
  }

  async clear(): Promise<void> {
    await this.#backend.delete(ACCOUNT)
    this.#has = false
  }
}
