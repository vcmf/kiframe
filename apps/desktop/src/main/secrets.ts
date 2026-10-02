// The app's secrets (the vault: names and grants in app data, values in the keychain). The window
// lists and adds them (a value goes window → main → keychain, never back); the studio resolves
// them for granted uses, and every value is known to it for blurring and scrubbing (R6).
import { type SecretBackend, type SecretUse, Vault } from "@kiframe/vault"
import { SecretName } from "@kiframe/schema"
import type { SecretView } from "../shared/ipc.ts"

/** A secret name, or why not in words (a schema error's message is its issues' JSON). */
function secretName(name: string): string {
  const parsed = SecretName.safeParse(name.trim())
  if (!parsed.success)
    throw new Error(`"${name}": ${parsed.error.issues[0]?.message ?? "not a secret name"}`)
  return parsed.data
}

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
    const names = this.#vault.list().map((s) => s.name)
    const read = await Promise.all(names.map((name) => this.#backend.get(name)))
    const values = new Map<string, string>()
    names.forEach((name, i) => {
      const value = read[i]
      if (value !== undefined && value !== "") values.set(name, value)
    })
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

  /**
   * Adds a secret for `origin`, or a new value for one it has: the value to the keychain only. A
   * name another app already uses is refused (its value there would be replaced unseen).
   */
  async add(form: { name: string; kind: string; value: string }, origin: string): Promise<void> {
    await this.ready()
    const name = secretName(form.name)
    const existing = this.#vault.list().find((s) => s.name === name)
    if (existing !== undefined && !existing.origins.includes(origin)) {
      throw new Error(
        `"${name}" is already a secret of ${existing.origins.join(", ")}: pick another name for this app`,
      )
    }
    const result = await this.#vault.request(
      { name, kind: form.kind, origin, reason: "added by the user" },
      () => Promise.resolve(form.value),
    )
    if (result !== "provided") throw new Error("a secret needs a value")
    this.#values.set(name, form.value)
  }

  /**
   * Takes a secret off `origin` (its approvals there): the secret itself, its value, only when no
   * other app uses it.
   */
  async remove(name: string, origin: string): Promise<void> {
    const checked = secretName(name)
    await this.#vault.removeOrigin(checked, origin)
    if (!this.#vault.list().some((s) => s.name === checked)) this.#values.delete(checked)
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
