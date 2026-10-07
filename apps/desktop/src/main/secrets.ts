// The app's secrets (the vault: names and grants in app data, values in the keychain). The window
// lists and adds them (a value goes window → main → keychain, never back); the studio resolves
// them for granted uses, and every value is known to it for blurring and scrubbing (R6).
import { type SecretBackend, type SecretKind, type SecretUse, Vault } from "@kiframe/vault"
import { SecretName } from "@kiframe/schema"
import type { SecretView } from "../shared/ipc.ts"

/** A secret name, or why not in words (a schema error's message is its issues' JSON). */
function secretName(name: string): string {
  const parsed = SecretName.safeParse(name.trim())
  // The name is never repeated: one refused may be a value pasted in by mistake.
  if (!parsed.success) {
    throw new Error(
      `that isn't a secret name (${parsed.error.issues[0]?.message ?? "letters, digits, dots"})`,
    )
  }
  return parsed.data
}

// The window's kinds are the vault's (a kind added there must be added to the contract too).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _kinds: Same<SecretView["kind"], SecretKind> = true
void _kinds

export class Secrets {
  readonly #vault: Vault
  readonly #backend: SecretBackend
  /** Every secret's value (main only: the studio's scrubber and the recorder's blur). */
  #values = new Map<string, string>()
  #loaded: Promise<void> | undefined
  #reloading = false
  /** Values replaced since the app started (still scrubbed and blurred until it quits). */
  readonly #retired = new Set<string>()

  constructor(path: string, backend: SecretBackend) {
    this.#vault = Vault.open(path, backend)
    this.#backend = backend
  }

  /**
   * The values loaded from the keychain (before a run: the studio must know them all). One that
   * couldn't be read (a dismissed prompt, a locked keychain) is read again by the next call.
   */
  ready(): Promise<void> {
    const missing = () => this.#vault.list().some((s) => !this.#values.has(s.name))
    if (this.#loaded === undefined) this.#loaded = this.#load()
    else if (!this.#reloading && missing()) {
      // One reload at a time (the calls meanwhile wait for it).
      this.#reloading = true
      this.#loaded = this.#loaded
        .then(() => this.#load())
        .finally(() => {
          this.#reloading = false
        })
    }
    return this.#loaded
  }

  async #load(): Promise<void> {
    // Only what isn't known yet (a reload reads the ones the keychain didn't give).
    const names = this.#vault
      .list()
      .map((s) => s.name)
      .filter((name) => !this.#values.has(name))
    // One that can't be read (a refused keychain prompt, a corrupt item) is skipped: listed as
    // having no value here, never failing every run.
    const read = await Promise.all(
      names.map((name) => this.#backend.get(name).catch(() => undefined)),
    )
    const values = new Map<string, string>()
    names.forEach((name, i) => {
      const value = read[i]
      if (value !== undefined && value !== "") values.set(name, value)
    })
    // Values set or kept meanwhile (an add during the load) win: a load never undoes a change.
    for (const [name, value] of this.#values) values.set(name, value)
    this.#values = values
  }

  /** The secrets usable on `origin` (an app's exact origin), as the window shows them. */
  list(origin: string): SecretView[] {
    return this.#vault
      .list()
      .filter((s) => s.origins.includes(origin))
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
    // Another app has it (alone, or with this one): its value there would be replaced unseen.
    const others = existing?.origins.filter((o) => o !== origin) ?? []
    if (others.length > 0) {
      throw new Error(
        `"${name}" is already a secret of ${others.join(", ")}: pick another name for this app`,
      )
    }
    const result = await this.#vault.request(
      { name, kind: form.kind, origin, reason: "added by the user" },
      () => Promise.resolve(form.value),
    )
    if (result !== "provided") throw new Error("a secret needs a value")
    // The old value stays known until the app quits (a page may still show it: R6).
    const old = this.#values.get(name)
    if (old !== undefined && old !== form.value) this.#retired.add(old)
    this.#values.set(name, form.value)
  }

  /**
   * Takes a secret off `origin` (its approvals there): the secret itself, its value, only when no
   * other app uses it.
   */
  async remove(name: string, origin: string): Promise<void> {
    const checked = secretName(name)
    await this.#vault.removeOrigin(checked, origin)
    // Its value stays known until the app quits: a page still showing it is still scrubbed and
    // blurred (R6).
  }

  /**
   * The studio's: the secrets usable on an app's exact origin, and whether each has a value (a
   * removed one's value is still known, never usable).
   */
  names(origin: string): { name: string; provided: boolean }[] {
    return this.list(origin).map(({ name, provided }) => ({ name, provided }))
  }

  /** Every value (R6: blurred on screen and scrubbed even when not typed). */
  knownValues(): ReadonlySet<string> {
    return new Set([...this.#values.values(), ...this.#retired])
  }

  /** The runtime's resolver: a value only for a use a grant covers. */
  resolve(name: string, use: SecretUse): Promise<string> {
    return this.#vault.resolve(name, use)
  }

  /** A project's approvals on a site it no longer lists (`Vault.revokeAt`: no keychain read). */
  revokeAt(scope: string, origin: string): void {
    this.#vault.revokeAt(scope, origin)
  }

  /** The user approved this use (the host's dialog only). */
  async approve(name: string, use: SecretUse): Promise<void> {
    await this.#vault.approve(name, use)
  }
}
