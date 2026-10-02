// The app's secrets (the vault: names and grants in app data, values in the keychain). The window
// lists and adds them (a value goes window → main → keychain, never back); the studio resolves
// them for granted uses, and every value is known to it for blurring and scrubbing (R6).
import { type SecretBackend, type SecretUse, Vault } from "@kiframe/vault"
import { SecretName } from "@kiframe/schema"
import type { SecretView } from "../shared/ipc.ts"

export class Secrets {
  readonly #vault: Vault
  readonly #backend: SecretBackend
  /** Every secret's value (main only: the studio's scrubber and the recorder's blur). */
  #values = new Map<string, string>()
  #loaded: Promise<void> | undefined

  constructor(path: string, backend: SecretBackend) {
    this.#vault = Vault.open(path, backend)
    this.#backend = backend
  }

  /** The values loaded from the keychain (before a run: the studio must know them all). */
  ready(): Promise<void> {
    this.#loaded ??= this.#load().catch((e: unknown) => {
      this.#loaded = undefined
      throw e
    })
    return this.#loaded
  }

  async #load(): Promise<void> {
    const values = new Map<string, string>()
    for (const { name } of this.#vault.list()) {
      const value = await this.#backend.get(name)
      if (value !== undefined && value !== "") values.set(name, value)
    }
    this.#values = values
  }

  /** The secrets usable on `origin` (the project's app), as the window shows them. */
  list(origin: string | null): SecretView[] {
    return this.#vault
      .list()
      .filter((s) => origin === null || s.origins.includes(origin))
      .map((s) => ({
        name: s.name,
        kind: s.kind,
        origins: s.origins,
        provided: this.#values.has(s.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Adds a secret (or a new value, or a new origin for it): the value to the keychain only. */
  async add(form: { name: string; kind: string; value: string }, origin: string): Promise<void> {
    await this.ready()
    const name = SecretName.parse(form.name)
    const result = await this.#vault.request(
      { name, kind: form.kind, origin, reason: "added by the user" },
      () => Promise.resolve(form.value),
    )
    if (result !== "provided") throw new Error("a secret needs a value")
    this.#values.set(name, form.value)
  }

  /** Removes a secret: its value, its metadata and every approval of it. */
  async remove(name: string): Promise<void> {
    await this.#vault.remove(name)
    this.#values.delete(name)
  }

  /** The studio's: the secrets usable on the project's app, and whether each has a value. */
  names(origin: string | null): { name: string; provided: boolean }[] {
    return this.list(origin).map(({ name, provided }) => ({ name, provided }))
  }

  /** Every value (R6: blurred on screen and scrubbed even when not typed). */
  knownValues(): ReadonlySet<string> {
    return new Set(this.#values.values())
  }

  /** The runtime's resolver: a value only for a use a grant covers. */
  resolve(name: string, use: SecretUse): Promise<string> {
    return this.#vault.resolve(name, use)
  }

  /** The user approved this use (the host's dialog only). */
  async approve(name: string, use: SecretUse): Promise<void> {
    await this.#vault.approve(name, use)
  }
}
