import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
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

/** Stable JSON (sorted keys): two bindings are the same field iff their canonical forms are equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export class Vault {
  readonly #path: string
  readonly #backend: SecretBackend
  #secrets: SecretMeta[]
  /** Writes one after another (a crash mid-write leaves the previous file, never a torn one). */
  #writing: Promise<void> = Promise.resolve()

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
    const value = await ask({ name, kind, origin, reason: form.reason.slice(0, 500) })
    if (value === undefined || value === "") return "declined"
    await this.#backend.set(name, value)
    const old = this.#find(name)
    const origins = old === undefined ? [origin] : [...new Set([...old.origins, origin])]
    // A new value keeps its field binding: it's the same login, just another password.
    const meta: SecretMeta = {
      name,
      kind,
      origins,
      ...(old?.field !== undefined && { field: old.field }),
      updatedAt: new Date().toISOString(),
    }
    await this.#save([...this.#secrets.filter((s) => s.name !== name), meta])
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
    const field = FieldBinding.parse(use.field)
    if (meta.field !== undefined && canonical(meta.field) !== canonical(field)) {
      throw new SecretRefusal(
        `secret "${name}" is bound to another field: the user can unbind it in the vault if the form changed`,
      )
    }
    const value = await this.#backend.get(name)
    if (value === undefined || value === "") {
      throw new SecretRefusal(`secret "${name}" has no value on this machine`)
    }
    if (meta.field === undefined) {
      await this.#save(this.#secrets.map((s) => (s.name === name ? { ...s, field } : s)))
    }
    return value
  }

  /** The runtime's resolver (`RunOptions.resolveSecret`). */
  resolver(): (name: string, use: SecretUse) => Promise<string> {
    return (name, use) => this.resolve(name, use)
  }

  /** The user's action (never an agent tool): the next use binds the field again. */
  async unbind(name: string): Promise<void> {
    await this.#save(
      this.#secrets.map((s) => {
        if (s.name !== name) return s
        const { field: _, ...rest } = s
        return rest
      }),
    )
  }

  /** Removes a secret: its value from the keychain, its metadata from the vault. */
  async remove(name: string): Promise<void> {
    await this.#backend.delete(name)
    await this.#save(this.#secrets.filter((s) => s.name !== name))
  }

  #find(name: string): SecretMeta | undefined {
    return this.#secrets.find((s) => s.name === name)
  }

  async #save(secrets: SecretMeta[]): Promise<void> {
    const file: VaultFile = VaultFile.parse({ version: 1, secrets })
    const write = this.#writing.then(() => {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 })
      const tmp = `${this.#path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.#path)
    })
    this.#writing = write.catch(() => undefined)
    await write
    this.#secrets = file.secrets
  }
}
