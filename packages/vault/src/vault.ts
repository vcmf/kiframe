import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { SecretName } from "@kiframe/schema"
import type { SecretBackend } from "./backend.ts"
import {
  FieldBinding,
  Origin,
  SecretKind,
  SecretMeta,
  VaultFile,
  type FieldBinding as Field,
} from "./meta.ts"

// The vault (APPROACHES §7.4). The agent knows WHAT secrets exist (`list`), asks the user for a
// missing one (`request`: it only learns "provided" or "declined"), and the runtime resolves one
// only for a `type` into its bound field on one of its origins (`resolve`). No method returns a
// value to anything but the runtime's resolver.

/** A refused resolution. Its message names the secret and the reason, never a value. */
export class SecretRefusal extends Error {
  /** What the runtime recognizes (not `instanceof`: it may come over IPC). */
  readonly code = "secret-refused"
  constructor(message: string) {
    super(message)
    this.name = "SecretRefusal"
  }
}

/** Where and into what the runtime is about to type a secret. */
export interface SecretUse {
  /** The page's origin. */
  origin: string
  field: Field
}

/** What the user's form is told (the host shows it; the value never goes back to the agent). */
export interface SecretForm {
  name: string
  kind: SecretKind
  origin: string
  /** The agent's reason, shown to the user as is. */
  reason: string
}

/** The host's native form: the value the user typed, or undefined if they declined. */
export type AskUser = (form: SecretForm) => Promise<string | undefined>

export class Vault {
  readonly #path: string
  readonly #backend: SecretBackend
  #secrets: SecretMeta[]

  private constructor(path: string, backend: SecretBackend, secrets: SecretMeta[]) {
    this.#path = path
    this.#backend = backend
    this.#secrets = secrets
  }

  /**
   * Opens the vault whose metadata is `path` (created on first write). A file that doesn't parse
   * is an error, never reset: the user would lose track of their secrets.
   */
  static open(path: string, backend: SecretBackend): Vault {
    if (!existsSync(path)) return new Vault(path, backend, [])
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      throw new Error(`the vault's metadata (${path}) isn't valid JSON`)
    }
    const parsed = VaultFile.safeParse(raw)
    if (!parsed.success) throw new Error(`the vault's metadata (${path}) is invalid`)
    return new Vault(path, backend, parsed.data.secrets)
  }

  /** Names and metadata of every secret: what the agent may see. */
  list(): SecretMeta[] {
    return structuredClone(this.#secrets)
  }

  /**
   * Asks the user for a secret's value (new, or replacing the old one) through the host's form.
   * Returns only whether they provided it. A new origin is added to the secret's origins.
   */
  async request(
    form: { name: string; kind: string; origin: string; reason: string },
    ask: AskUser,
  ): Promise<"provided" | "declined"> {
    const name = SecretName.parse(form.name)
    const kind = SecretKind.parse(form.kind)
    const origin = Origin.parse(form.origin)
    // A secret's kind is the user's, not the agent's to change (a password never becomes `text`).
    const checkKind = () => {
      const existing = this.#find(name)
      if (existing !== undefined && existing.kind !== kind) {
        throw new Error(`secret "${name}" is a ${existing.kind}, not a ${kind}`)
      }
    }
    checkKind()
    // Checked before asking: the user never types a value the vault then can't record.
    const updated = (secrets: readonly SecretMeta[]) => {
      const old = secrets.find((s) => s.name === name)
      // A new value keeps its field binding: it's the same login, just another password.
      const meta: SecretMeta = {
        name,
        kind,
        origins: old === undefined ? [origin] : [...new Set([...old.origins, origin])],
        ...(old?.field !== undefined && { field: old.field }),
        updatedAt: new Date().toISOString(),
      }
      return [...secrets.filter((s) => s.name !== name), meta]
    }
    VaultFile.parse({ version: 1, secrets: updated(this.#secrets) })
    const value = await ask({ name, kind, origin, reason: form.reason.slice(0, 500) })
    if (value === undefined || value === "") return "declined"
    // Again on the latest metadata (another request may have run while the user typed), before
    // the old value is replaced.
    checkKind()
    VaultFile.parse({ version: 1, secrets: updated(this.#secrets) })
    await this.#backend.set(name, value)
    this.#update(updated)
    return "provided"
  }

  /**
   * The value, for the runtime's `type` only: on one of the secret's origins, into its bound field
   * (bound now if this is its first use). Refusals are `SecretRefusal`s.
   */
  async resolve(name: string, use: SecretUse): Promise<string> {
    const meta = this.#find(name)
    if (meta === undefined) throw new SecretRefusal(`secret "${name}" isn't in the vault`)
    if (!meta.origins.includes(use.origin)) {
      throw new SecretRefusal(`secret "${name}" isn't allowed on ${use.origin}`)
    }
    const parsed = FieldBinding.safeParse(use.field)
    if (!parsed.success) throw new SecretRefusal(`secret "${name}": the field can't be identified`)
    const field = parsed.data
    if (meta.field !== undefined && !isDeepStrictEqual(meta.field, field)) {
      throw new SecretRefusal(
        `secret "${name}" is bound to another field: the user can unbind it in the vault if the form changed`,
      )
    }
    const value = await this.#backend.get(name)
    if (value === undefined || value === "") {
      throw new SecretRefusal(`secret "${name}" has no value on this machine`)
    }
    // Checked again after the wait: a concurrent first use may have bound another field.
    const latest = this.#find(name)
    if (latest === undefined || !latest.origins.includes(use.origin)) {
      throw new SecretRefusal(`secret "${name}" changed while it was resolved`)
    }
    if (latest.field !== undefined && !isDeepStrictEqual(latest.field, field)) {
      throw new SecretRefusal(`secret "${name}" is bound to another field`)
    }
    // Bound at first use (the latest metadata: another call may have bound it meanwhile).
    this.#update((secrets) =>
      secrets.map((s) => (s.name === name && s.field === undefined ? { ...s, field } : s)),
    )
    return value
  }

  /** The runtime's resolver (`RunOptions.resolveSecret`). */
  resolver(): (name: string, use: SecretUse) => Promise<string> {
    return (name, use) => this.resolve(name, use)
  }

  /** The user's action (never an agent tool): the next use binds the field again. */
  unbind(name: string): void {
    this.#update((secrets) =>
      secrets.map((s) => {
        if (s.name !== name) return s
        const { field: _, ...rest } = s
        return rest
      }),
    )
  }

  /** Removes a secret: its value from the keychain, its metadata from the vault. */
  async remove(name: string): Promise<void> {
    await this.#backend.delete(name)
    this.#update((secrets) => secrets.filter((s) => s.name !== name))
  }

  #find(name: string): SecretMeta | undefined {
    return this.#secrets.find((s) => s.name === name)
  }

  /**
   * Applies a change to the LATEST metadata and writes it, synchronously: no other call can run in
   * between, so no update is lost. Atomic on disk (a crash leaves the previous file).
   */
  #update(change: (secrets: readonly SecretMeta[]) => SecretMeta[]): void {
    const file: VaultFile = VaultFile.parse({ version: 1, secrets: change(this.#secrets) })
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 })
    const tmp = `${this.#path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.#path)
    this.#secrets = file.secrets
  }
}
