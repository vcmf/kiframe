import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { createHmac, randomBytes } from "node:crypto"
import { dirname } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { SecretName } from "@kiframe/schema"
import type { SecretBackend } from "./backend.ts"
import * as z from "zod"
import {
  ElementInfo,
  Grant,
  Origin,
  PathPattern,
  SecretKind,
  SecretMeta,
  StepKey,
  VaultFile,
} from "./meta.ts"

// The vault (APPROACHES §7.4, SECRETS-DESIGN §3). The agent knows WHAT secrets exist (`list`),
// asks the user for a missing one (`request`: it only learns "provided" or "declined"), and the
// runtime resolves one only for a use a user's grant covers (`resolve`); the host creates grants
// from the user's approvals (`approve`). No method returns a value to anything but the runtime's
// resolver.

/** Why a resolution was refused: `no-grant` is the one a user's approval can fix. */
export type RefusalReason =
  "unknown-secret" | "no-value" | "origin" | "kind" | "no-grant" | "invalid-use"

/** A refused resolution. Its message names the secret and the reason, never a value. */
export class SecretRefusal extends Error {
  /** What the runtime recognizes (not `instanceof`: it may come over IPC). */
  readonly code = "secret-refused"
  readonly reason: RefusalReason
  constructor(reason: RefusalReason, message: string) {
    super(message)
    this.name = "SecretRefusal"
    this.reason = reason
  }
}

/** A use the runtime asks for (SECRETS-DESIGN §3 A2): everything a grant is checked against. */
export const SecretUse = z.strictObject({
  scope: z.string().min(1).max(200),
  stepKey: StepKey,
  origin: Origin,
  /** The page's pathname. */
  path: z.string().max(2000).regex(/^\//),
  target: z.string().min(2).max(4000),
  element: ElementInfo,
})
export type SecretUse = z.infer<typeof SecretUse>

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

/** The keychain entry of the grants' hash key (not a valid secret name: never a user's secret). */
const GRANT_KEY = "#grant-hash-key"

/** A plain path pattern as stored: literal segments hashed, `*` kept. */
function hashPattern(pattern: string, hash: (s: string) => string): string {
  if (pattern === "*") return "*"
  return pattern
    .split("/")
    .map((s) => (s === "" || s === "*" ? s : hash(s)))
    .join("/")
}

/** A path's default pattern (§3 A1): numeric, UUID and long hex segments become `*`. */
export function pathPatternOf(pathname: string): string {
  return pathname
    .split("/")
    .map((s) =>
      /^\d+$/.test(s) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
      /^[0-9a-f]{16,}$/i.test(s)
        ? "*"
        : s,
    )
    .join("/")
}

/** Whether a pathname matches a pattern: same segments, `*` for any one non-empty segment. */
export function pathMatches(pattern: string, pathname: string): boolean {
  if (pattern === "*") return true // an interrupt rule's grant: every path on its origin (§3 A1)
  const want = pattern.split("/")
  const got = pathname.split("/")
  return (
    want.length === got.length && want.every((w, i) => w === got[i] || (w === "*" && got[i] !== ""))
  )
}

/** Whether a use is an interrupt rule's (§3 A6: passwords only), from its step key. */
const isInterrupt = (stepKey: string) => /^(org:[^/]+\/)?interrupt:/.test(stepKey)

/** Which elements a kind of secret may go into (§3 A2). */
function kindAllows(kind: SecretKind, element: ElementInfo): boolean {
  if (kind === "password") return element.tag === "input" && element.type === "password"
  if (kind === "text") return true
  return (
    element.tag === "input" && ["text", "email", "tel", "url", "password"].includes(element.type)
  )
}

export class Vault {
  readonly #path: string
  readonly #backend: SecretBackend
  #secrets: SecretMeta[]
  #grants: Grant[]
  #key: Promise<string> | undefined

  private constructor(path: string, backend: SecretBackend, file: VaultFile) {
    this.#path = path
    this.#backend = backend
    this.#secrets = file.secrets
    this.#grants = file.grants
  }

  /**
   * Opens the vault whose metadata is `path` (created on first write). A file that doesn't parse
   * is an error, never reset: the user would lose track of their secrets.
   */
  static open(path: string, backend: SecretBackend): Vault {
    if (!existsSync(path)) return new Vault(path, backend, { version: 1, secrets: [], grants: [] })
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(path, "utf8"))
    } catch {
      throw new Error(`the vault's metadata (${path}) isn't valid JSON`)
    }
    const parsed = VaultFile.safeParse(raw)
    if (!parsed.success) throw new Error(`the vault's metadata (${path}) is invalid`)
    return new Vault(path, backend, parsed.data)
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
      const meta: SecretMeta = {
        name,
        kind,
        origins: old === undefined ? [origin] : [...new Set([...old.origins, origin])],
        updatedAt: new Date().toISOString(),
      }
      return [...secrets.filter((s) => s.name !== name), meta]
    }
    VaultFile.parse({ version: 1, secrets: updated(this.#secrets), grants: this.#grants })
    const value = await ask({ name, kind, origin, reason: form.reason.slice(0, 500) })
    if (value === undefined || value === "") return "declined"
    // Again on the latest metadata (another request may have run while the user typed), before
    // the old value is replaced.
    checkKind()
    VaultFile.parse({ version: 1, secrets: updated(this.#secrets), grants: this.#grants })
    await this.#backend.set(name, value)
    this.#update((file) => ({ ...file, secrets: updated(file.secrets) }))
    return "provided"
  }

  /**
   * The value, for the runtime's `type` only (SECRETS-DESIGN §3 A2): on one of the secret's
   * origins, for a step, target, path and element a user's grant covers, into an element the
   * secret's kind allows. Refusals are `SecretRefusal`s.
   */
  async resolve(name: string, use: SecretUse): Promise<string> {
    const parsed = SecretUse.safeParse(use)
    if (!parsed.success) throw new SecretRefusal("invalid-use", `secret "${name}": invalid use`)
    const u = parsed.data
    const hash = await this.#hasher()
    const check = () => {
      const meta = this.#find(name)
      if (meta === undefined) {
        throw new SecretRefusal("unknown-secret", `secret "${name}" isn't in the vault`)
      }
      if (!meta.origins.includes(u.origin)) {
        throw new SecretRefusal("origin", `secret "${name}" isn't allowed on ${u.origin}`)
      }
      if (isInterrupt(u.stepKey) && meta.kind !== "password") {
        throw new SecretRefusal("kind", `secret "${name}": interrupt rules only type passwords`)
      }
      if (!kindAllows(meta.kind, u.element)) {
        throw new SecretRefusal(
          "kind",
          `secret "${name}" is a ${meta.kind}: it doesn't go into ${u.element.tag === "input" ? `an input of type ${u.element.type}` : "a textarea"}`,
        )
      }
      if (this.#grantFor(name, u, hash) === undefined) {
        throw new SecretRefusal("no-grant", `secret "${name}": ${this.#whyNoGrant(name, u, hash)}`)
      }
    }
    check()
    const value = await this.#backend.get(name)
    if (value === undefined || value === "") {
      throw new SecretRefusal("no-value", `secret "${name}" has no value on this machine`)
    }
    // Again after the wait: the secret or its grant may have been removed meanwhile.
    check()
    return value
  }

  /** The runtime's resolver (`RunOptions.resolveSecret`). */
  resolver(): (name: string, use: SecretUse) => Promise<string> {
    return (name, use) => this.resolve(name, use)
  }

  /**
   * The user approved a use (the host's approval UI only, never an agent tool): a grant for its
   * step, target and element, on its origin, for `pathPattern` (default: the use's path with ids
   * as `*`). Replaces an older grant for the same step and secret.
   */
  async approve(name: string, use: SecretUse, pathPattern?: string): Promise<Grant> {
    const u = SecretUse.parse(use)
    // An interrupt shows anywhere ("Session expired"): its grant covers every path (§3 A1).
    pathPattern ??= isInterrupt(u.stepKey) ? "*" : pathPatternOf(u.path)
    PathPattern.parse(pathPattern)
    if (!pathMatches(pathPattern, u.path)) {
      throw new Error("the path pattern doesn't cover the page it was approved on")
    }
    // Nothing page-derived in the clear (§3 A1): literal segments and the label as keyed hashes.
    const hash = await this.#hasher()
    if (this.#find(name) === undefined) throw new Error(`secret "${name}" isn't in the vault`)
    const grant = Grant.parse({
      scope: u.scope,
      stepKey: u.stepKey,
      secret: name,
      origin: u.origin,
      pathPattern: hashPattern(pathPattern, hash),
      target: u.target,
      element: { ...u.element, label: u.element.label === null ? null : hash(u.element.label) },
      grantedAt: new Date().toISOString(),
    })
    this.#update((file) => ({
      ...file,
      grants: [
        // Replaces the grant for the same step and secret on the same origin and pages only: a
        // step running on several origins (staging, prod) or pages (/en/login, /fr/login) keeps
        // one grant for each.
        ...file.grants.filter(
          (g) =>
            !(
              g.scope === grant.scope &&
              g.stepKey === grant.stepKey &&
              g.secret === name &&
              g.origin === grant.origin &&
              g.pathPattern === grant.pathPattern
            ),
        ),
        grant,
      ],
    }))
    return grant
  }

  /** The grants (all, or one scope's): what the vault UI lists. */
  grants(scope?: string): Grant[] {
    return structuredClone(
      scope === undefined ? this.#grants : this.#grants.filter((g) => g.scope === scope),
    )
  }

  /** The user's action: the step asks again next time. */
  revoke(scope: string, stepKey: string, secret: string): void {
    this.#update((file) => ({
      ...file,
      grants: file.grants.filter(
        (g) => !(g.scope === scope && g.stepKey === stepKey && g.secret === secret),
      ),
    }))
  }

  /** Removes a secret: its value from the keychain, its metadata and grants from the vault. */
  async remove(name: string): Promise<void> {
    await this.#backend.delete(name)
    this.#update((file) => ({
      ...file,
      secrets: file.secrets.filter((s) => s.name !== name),
      grants: file.grants.filter((g) => g.secret !== name),
    }))
  }

  #find(name: string): SecretMeta | undefined {
    return this.#secrets.find((s) => s.name === name)
  }

  /** What stopped a use matching (§3 A4: the user must tell "never approved" from "changed"). */
  #whyNoGrant(name: string, u: SecretUse, hash: (s: string) => string): string {
    const mine = this.#grants.filter(
      (g) => g.secret === name && g.scope === u.scope && g.stepKey === u.stepKey,
    )
    if (mine.length === 0) return `isn't approved for this step (${u.stepKey})`
    const onOrigin = mine.filter((g) => g.origin === u.origin)
    if (onOrigin.length === 0) return "approved for this step on another origin"
    if (!onOrigin.some((g) => g.target === u.target)) {
      return "approved for another target: the step's target changed (healed or re-grounded)"
    }
    if (
      !onOrigin.some(
        (g) => g.target === u.target && pathMatches(g.pathPattern, hashPattern(u.path, hash)),
      )
    ) {
      return "approved on other pages, not this one"
    }
    return "approved for another field: the element's type or label changed"
  }

  /** The key of the grants' hashes (in the keychain, created on first use; kept in memory). */
  #hashKey(): Promise<string> {
    // One promise for every caller: concurrent first uses share one key.
    this.#key ??= (async () => {
      const stored = await this.#backend.get(GRANT_KEY)
      if (stored !== undefined && /^[0-9a-f]{64}$/.test(stored)) return stored
      // A new key only for a vault with no grants yet: with grants, a lost key would silently
      // invalidate them all (every use would read as "approved for another field").
      if (this.#grants.length > 0) {
        throw new SecretRefusal(
          "no-grant",
          "the key of the vault's approvals is missing from the keychain: approve the steps again",
        )
      }
      const key = randomBytes(32).toString("hex")
      await this.#backend.set(GRANT_KEY, key)
      return key
    })().catch((error: unknown) => {
      this.#key = undefined
      throw error
    })
    return this.#key
  }

  /** Page-derived text as it's stored and compared: its keyed hash. */
  async #hasher(): Promise<(text: string) => string> {
    const key = await this.#hashKey()
    return (text) => createHmac("sha256", key).update(text).digest("hex")
  }

  #grantFor(name: string, u: SecretUse, hash: (s: string) => string): Grant | undefined {
    const element = { ...u.element, label: u.element.label === null ? null : hash(u.element.label) }
    return this.#grants.find(
      (g) =>
        g.secret === name &&
        g.scope === u.scope &&
        g.stepKey === u.stepKey &&
        g.origin === u.origin &&
        g.target === u.target &&
        pathMatches(g.pathPattern, hashPattern(u.path, hash)) &&
        isDeepStrictEqual(g.element, element),
    )
  }

  /**
   * Applies a change to the LATEST metadata and writes it, synchronously: no other call can run in
   * between, so no update is lost. Atomic on disk (a crash leaves the previous file).
   */
  #update(change: (file: VaultFile) => VaultFile): void {
    const file: VaultFile = VaultFile.parse(
      change({ version: 1, secrets: this.#secrets, grants: this.#grants }),
    )
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 })
    const tmp = `${this.#path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.#path)
    this.#secrets = file.secrets
    this.#grants = file.grants
  }
}
