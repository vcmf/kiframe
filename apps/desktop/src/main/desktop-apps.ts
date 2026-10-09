// Desktop apps a user added (PR 3b, design reviewed 2026-10-09): approved on this Mac and per
// project, kept in app data (never the project: a project from someone else names an app by its
// bundle id only). An approval covers the app (its developer, or the exact build of an unsigned one)
// AND what the project opens with it (its arguments and sites): a project that changed either asks
// again. Adding one: picked by the user, inspected (nothing runs), tried confined, then added.
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type OpenedProject, saveProject } from "@kiframe/project"
import type { DesktopApp, Signer, TrialOptions, TrialOutcome } from "@kiframe/runtime"
import { type App, BUNDLE_ID, type ElectronApp } from "@kiframe/schema"
import { z } from "zod"

const SignerSchema = z.union([
  z.strictObject({
    kind: z.literal("team"),
    team: z.string().max(64),
    identifier: z.string().max(255),
  }),
  z.strictObject({ kind: z.literal("pinned"), digest: z.string().regex(/^[0-9a-f]{64}$/) }),
])

const Approval = z.strictObject({
  /** Where the app was picked (its real path). */
  path: z.string().max(4096),
  name: z.string().max(200),
  version: z.string().max(100).optional(),
  signer: SignerSchema,
  approvedAt: z.string(),
  /** Per project folder (the registry's scope): what it opens with the app, approved. */
  scopes: z.record(z.string(), z.strictObject({ opens: z.string().regex(/^[0-9a-f]{64}$/) })),
})
type Approval = z.infer<typeof Approval>

const File = z.strictObject({
  version: z.literal(1),
  apps: z.record(z.string().regex(BUNDLE_ID), Approval),
})
type File = z.infer<typeof File>

/** What a project opens with an app (its arguments and sites), as one digest. */
export function opensOf(app: Pick<ElectronApp, "args" | "origins">): string {
  return createHash("sha256")
    .update(JSON.stringify({ args: app.args ?? [], origins: app.origins ?? [] }))
    .digest("hex")
}

/** The store's key: bundle ids compare without case (as the schema's project does). */
const keyOf = (bundleId: string) => bundleId.toLowerCase()

/**
 * The approvals file (`desktop-apps.json` in app data, 0600, written whole). One that doesn't read
 * is set aside (renamed, said once), never overwritten: approvals start over, none lost silently.
 */
export class DesktopApprovals {
  readonly #path: string
  #file: File
  /** Why the file was set aside, once (shown by the panel). */
  problem: string | null = null

  constructor(dir: string) {
    this.#path = join(dir, "desktop-apps.json")
    this.#file = { version: 1, apps: {} }
    if (!existsSync(this.#path)) return
    try {
      this.#file = File.parse(JSON.parse(readFileSync(this.#path, "utf8")))
    } catch {
      const aside = `${this.#path}.bad-${Date.now()}`
      renameSync(this.#path, aside)
      this.problem = `the desktop apps' approvals didn't read: set aside as ${aside}; add them again`
    }
  }

  get(bundleId: string): Approval | undefined {
    const key = keyOf(bundleId)
    return Object.hasOwn(this.#file.apps, key) ? this.#file.apps[key] : undefined
  }

  /** The app as inspected now, approved for this project folder and what it opens. */
  approve(app: DesktopApp, scope: string, opens: string): void {
    const known = this.get(app.bundleId)
    const sameApp =
      known !== undefined && known.path === app.path && sameSigner(known.signer, app.signer)
    this.#file.apps[keyOf(app.bundleId)] = {
      path: app.path,
      name: app.name,
      ...(app.version !== undefined && { version: app.version }),
      signer: app.signer,
      approvedAt: new Date().toISOString(),
      // Another build or another place: the other projects' approvals go (they approved that one).
      scopes: { ...(sameApp ? known.scopes : {}), [scope]: { opens } },
    }
    this.#save()
  }

  /** This project folder's approval of the app taken back (the app removed from the project). */
  drop(bundleId: string, scope: string): void {
    const known = this.get(bundleId)
    if (known === undefined || !Object.hasOwn(known.scopes, scope)) return
    delete known.scopes[scope]
    this.#save()
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.${randomBytes(6).toString("hex")}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.#file, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.#path)
  }
}

function sameSigner(a: Signer, b: Signer): boolean {
  return a.kind === "team"
    ? b.kind === "team" && a.team === b.team && a.identifier === b.identifier
    : b.kind === "pinned" && a.digest === b.digest
}

/**
 * A desktop app of the project, as this Mac has it: `ready`; `updated` (same developer, a new build:
 * tried before its next run); `allow` (approved for another project, or never on this Mac: pick it
 * to approve it here); `opens-changed` (the project changed what it opens with it); `changed` (another
 * developer, or another build of an unsigned one); `not-found` (no longer where it was picked).
 */
export type DesktopStatus =
  | { status: "ready" | "updated" }
  | { status: "allow" | "opens-changed" | "changed" | "not-found"; why: string }

/** The functions that look at an app (the runtime's; fakes in tests). */
export interface Looks {
  inspect: (path: string, signal?: AbortSignal) => Promise<DesktopApp>
  trial: (app: DesktopApp, opts: TrialOptions) => Promise<TrialOutcome>
}

/**
 * The project's desktop app's status, static only (opening the panel never launches anything): its
 * approval, the app inspected where it was picked, compared.
 */
export async function desktopStatus(
  entry: ElectronApp,
  scope: string,
  approvals: DesktopApprovals,
  looks: Pick<Looks, "inspect">,
): Promise<DesktopStatus> {
  const known = approvals.get(entry.bundleId)
  if (known === undefined) {
    return {
      status: "allow",
      why: "not added on this Mac: add it from Applications to use it here",
    }
  }
  let now: DesktopApp
  try {
    now = await looks.inspect(known.path)
  } catch (error) {
    if (!existsSync(known.path)) {
      return { status: "not-found", why: `not at ${known.path} any more: add it again` }
    }
    return { status: "changed", why: (error as Error).message }
  }
  if (keyOf(now.bundleId) !== keyOf(entry.bundleId) || !sameDeveloper(known.signer, now.signer)) {
    return { status: "changed", why: "another app is there now (or another build): add it again" }
  }
  const here = Object.hasOwn(known.scopes, scope) ? known.scopes[scope] : undefined
  if (here === undefined) {
    return { status: "allow", why: "approved for another project: allow it in this one" }
  }
  if (here.opens !== opensOf(entry)) {
    return {
      status: "opens-changed",
      why: "the project changed what it opens with it: allow it again",
    }
  }
  return now.version !== known.version && now.signer.kind === "team"
    ? { status: "updated" }
    : { status: "ready" }
}

/** Same developer (a team app updated is still theirs), or the same pinned build. */
function sameDeveloper(known: Signer, now: Signer): boolean {
  return known.kind === "team"
    ? now.kind === "team" && now.team === known.team && now.identifier === known.identifier
    : now.kind === "pinned" && now.digest === known.digest
}

/** An app's name in the project: its own, in the app-name form, made unique. */
export function appNameFor(name: string, taken: readonly string[]): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .replace(/-+$/, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "app"
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

/** What the window shows of a picked app (never its path). */
export interface DesktopCard {
  token: string
  name: string
  bundleId: string
  version: string | undefined
  electron: string
  /** Who stands behind it: a developer's team id, or none (pinned to this build). */
  signer: { kind: "team"; team: string } | { kind: "pinned" }
  /** The project already names it (a project from someone else): adding approves it here. */
  existing: string | undefined
  /**
   * What that project opens with it, shown before it's allowed: its arguments (paths in files/,
   * not passed to the check) and the sites it shows as its own (the check runs with them).
   */
  opens: { args: string[]; origins: string[] } | undefined
}

interface Pending {
  owner: number
  session: string
  app: DesktopApp
  existing: string | undefined
  /** What the project opened the app with when picked (an add after a change: refused). */
  opensAtPick: string | undefined
  /** The site the last trial named (kept here: the window never names one). */
  site: string | undefined
  /** Allowed by the user after a trial named it. */
  origins: string[]
  tried: boolean
  trial: AbortController | undefined
  /** An add under way (a second click waits for nothing: refused). */
  adding: boolean
}

/**
 * Adds in progress, one per window: the app picked (its path stays in main: the window has a
 * token), tried, then added. Dropped with the project or the window; every trial ends at a quit.
 */
export class DesktopAdds {
  readonly #pending = new Map<string, Pending>()
  /** Windows whose pick is being inspected (another pick meanwhile: refused). */
  readonly #picking = new Set<number>()
  readonly #looks: Looks
  readonly #workDir: string | undefined

  constructor(looks: Looks, workDir?: string) {
    this.#looks = looks
    this.#workDir = workDir
  }

  /** The app the user picked, inspected (refused: said); a window's earlier add dropped. */
  async pick(
    owner: number,
    session: string,
    path: string,
    project: { apps: Readonly<Record<string, App>> },
  ): Promise<DesktopCard> {
    if (this.#picking.has(owner)) throw new Error("an app is being looked at already")
    this.dropFor(owner)
    this.#picking.add(owner)
    let app: DesktopApp
    try {
      app = await this.#looks.inspect(path)
    } finally {
      this.#picking.delete(owner)
    }
    const named = Object.entries(project.apps).find(
      ([, a]) => a.kind === "electron" && keyOf(a.bundleId) === keyOf(app.bundleId),
    )
    const existing = named?.[0]
    // Named already: tried with the sites the project lists for it (what it'll run with), shown.
    const entry = named?.[1].kind === "electron" ? named[1] : undefined
    const listed = [...(entry?.origins ?? [])]
    const token = randomUUID()
    this.#pending.set(token, {
      owner,
      session,
      app,
      existing,
      opensAtPick: entry === undefined ? undefined : opensOf(entry),
      site: undefined,
      origins: listed,
      tried: false,
      trial: undefined,
      adding: false,
    })
    return {
      token,
      name: app.name,
      bundleId: app.bundleId,
      version: app.version,
      electron: app.electron,
      signer:
        app.signer.kind === "team" ? { kind: "team", team: app.signer.team } : { kind: "pinned" },
      existing,
      opens: entry === undefined ? undefined : { args: [...(entry.args ?? [])], origins: listed },
    }
  }

  /**
   * The picked app tried, confined. `allowSite`: with the site the last trial named (kept here),
   * as the app's own. A token of another window or project: refused.
   */
  async check(
    owner: number,
    session: string,
    token: string,
    allowSite: boolean,
  ): Promise<TrialOutcome> {
    const pending = this.#own(owner, session, token)
    if (pending.trial !== undefined) throw new Error("it's being checked already")
    if (allowSite) {
      if (pending.site === undefined) throw new Error("no site to allow: check it first")
      pending.origins = [...new Set([...pending.origins, pending.site])]
    }
    const stopping = new AbortController()
    pending.trial = stopping
    try {
      const outcome = await this.#looks.trial(pending.app, {
        origins: pending.origins,
        signal: stopping.signal,
        ...(this.#workDir !== undefined && { workDir: this.#workDir }),
      })
      pending.tried = "ok" in outcome
      pending.site = "site" in outcome ? outcome.site : undefined
      return outcome
    } finally {
      pending.trial = undefined
    }
  }

  /**
   * The tried app added to the project (or, named already, approved here): its build checked again
   * (the one tried), the project written first (its changed-on-disk refusal), then the approval.
   */
  async add(
    owner: number,
    session: string,
    token: string,
    opened: OpenedProject,
    scope: string,
    approvals: DesktopApprovals,
  ): Promise<string> {
    const pending = this.#own(owner, session, token)
    if (!pending.tried) throw new Error("check it first: it's added once it ran here")
    if (pending.adding) throw new Error("it's being added already")
    pending.adding = true
    try {
      const now = await this.#looks.inspect(pending.app.path)
      if (!sameSigner(now.signer, pending.app.signer)) {
        throw new Error("the app changed since it was checked: pick it again")
      }
      let name = pending.existing
      let entry: ElectronApp
      if (name !== undefined) {
        const named = opened.project.apps[name]
        // What the user saw at the pick, still (a project changed meanwhile: never approved untried).
        if (named?.kind !== "electron" || opensOf(named) !== pending.opensAtPick) {
          throw new Error("the project changed meanwhile: pick it again")
        }
        entry = named
        // A site allowed in the check: the project's too (its runs need it).
        if ((named.origins ?? []).length !== pending.origins.length) {
          entry = { ...named, origins: pending.origins }
          saveProject(opened, {
            ...opened.project,
            apps: { ...opened.project.apps, [name]: entry },
          })
        }
      } else {
        name = appNameFor(now.name, Object.keys(opened.project.apps))
        entry = {
          kind: "electron",
          bundleId: now.bundleId,
          ...(pending.origins.length > 0 && { origins: pending.origins }),
          viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        }
        saveProject(opened, { ...opened.project, apps: { ...opened.project.apps, [name]: entry } })
      }
      approvals.approve(now, scope, opensOf(entry))
      this.#pending.delete(token)
      return name
    } finally {
      pending.adding = false
    }
  }

  /** A window's add dropped (another pick, the window closed, the project changed). */
  dropFor(owner: number): void {
    for (const [token, pending] of this.#pending) {
      if (pending.owner !== owner) continue
      pending.trial?.abort()
      this.#pending.delete(token)
    }
  }

  /** Every add dropped, its trial ended (a quit, the project closed). */
  dropAll(): void {
    for (const pending of this.#pending.values()) pending.trial?.abort()
    this.#pending.clear()
  }

  #own(owner: number, session: string, token: string): Pending {
    const pending = this.#pending.get(token)
    if (pending === undefined || pending.owner !== owner || pending.session !== session) {
      throw new Error("that app isn't being added any more: pick it again")
    }
    return pending
  }
}
