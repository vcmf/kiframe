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
import { BUNDLE_ID, type ElectronApp } from "@kiframe/schema"
import { z } from "zod"

const SignerSchema = z.union([
  z.strictObject({
    kind: z.literal("team"),
    team: z.string().max(64),
    identifier: z.string().max(1024),
  }),
  z.strictObject({ kind: z.literal("pinned"), digest: z.string().regex(/^[0-9a-f]{64}$/) }),
])

/** One copy of an app approved on this Mac (where it was picked, who stands behind it). */
const Approval = z.strictObject({
  /** Where the app was picked (its real path). */
  path: z.string().max(4096),
  name: z.string().max(200),
  signer: SignerSchema,
  approvedAt: z.string(),
  /**
   * Per project folder (the registry's scope): what it opens with the app, approved, and the build
   * it tried (each project's own: another's update never changes its status).
   */
  scopes: z.record(
    z.string(),
    z.strictObject({
      opens: z.string().regex(/^[0-9a-f]{64}$/),
      version: z.string().max(100).optional(),
    }),
  ),
})
type Approval = z.infer<typeof Approval>

/** At most this many copies of one app kept (the oldest let go): the file always reads back. */
const MAX_COPIES = 20

/** A version as kept (cut: compared the same way). */
export const versionOf = (app: Pick<DesktopApp, "version">) => app.version?.slice(0, 100)

/**
 * Each bundle id's copies (a release in Applications, a dev build elsewhere: one id, several
 * apps): a project uses one of them.
 */
const File = z.strictObject({
  version: z.literal(1),
  apps: z.record(z.string().regex(BUNDLE_ID), z.array(Approval).max(MAX_COPIES)),
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
 * The approvals file (`desktop-apps.json` in app data, 0600, written whole: on disk first, then
 * kept). One that doesn't read is set aside (renamed, said once), never overwritten.
 */
export class DesktopApprovals {
  readonly #path: string
  #file: File
  #problem: string | null = null

  /** Why the file was set aside: given once (the panel says it), then null. */
  takeProblem(): string | null {
    const problem = this.#problem
    this.#problem = null
    return problem
  }

  constructor(dir: string) {
    this.#path = join(dir, "desktop-apps.json")
    this.#file = { version: 1, apps: {} }
    if (!existsSync(this.#path)) return
    try {
      this.#file = File.parse(JSON.parse(readFileSync(this.#path, "utf8")))
    } catch {
      const aside = `${this.#path}.bad-${Date.now()}`
      renameSync(this.#path, aside)
      this.#problem = `the desktop apps' approvals didn't read: set aside as ${aside}; add them again`
    }
  }

  /** The app's copies approved on this Mac. */
  copies(bundleId: string): readonly Approval[] {
    const key = keyOf(bundleId)
    return Object.hasOwn(this.#file.apps, key) ? (this.#file.apps[key] ?? []) : []
  }

  /** The copy this project folder uses (one at most). */
  copyFor(bundleId: string, scope: string): Approval | undefined {
    return this.copies(bundleId).find((copy) => Object.hasOwn(copy.scopes, scope))
  }

  /**
   * The app (the build that was tried) approved for this project folder and what it opens: its
   * copy (by place) kept with its other projects when it's the same build or developer, started
   * afresh when another is there now; the project's other copy of that id let go.
   */
  approve(app: DesktopApp, scope: string, opens: string): void {
    const atPlace = (copy: Approval) => copy.path === app.path
    const here = this.copies(app.bundleId).find(atPlace)
    const others = this.copies(app.bundleId)
      .filter((copy) => !atPlace(copy))
      .map((copy) => ({ ...copy, scopes: without(copy.scopes, scope) }))
      .filter((copy) => Object.keys(copy.scopes).length > 0)
    const kept = here !== undefined && sameSigner(here.signer, app.signer) ? here.scopes : {}
    const version = versionOf(app)
    const copy: Approval = {
      path: app.path,
      name: app.name.slice(0, 200),
      signer: app.signer,
      approvedAt: new Date().toISOString(),
      scopes: { ...kept, [scope]: { opens, ...(version !== undefined && { version }) } },
    }
    try {
      this.#write({
        ...this.#file.apps,
        [keyOf(app.bundleId)]: [...others, copy].slice(-MAX_COPIES),
      })
    } catch (error) {
      if ((error as Error).name !== "ZodError") throw error
      throw new Error("this app's details can't be kept (too long?)", { cause: error })
    }
  }

  /** This project folder's approval of the app taken back (the app removed from the project). */
  drop(bundleId: string, scope: string): void {
    if (this.copyFor(bundleId, scope) === undefined) return
    const copies = this.copies(bundleId)
      .map((copy) => ({ ...copy, scopes: without(copy.scopes, scope) }))
      .filter((copy) => Object.keys(copy.scopes).length > 0)
    this.#write({ ...this.#file.apps, [keyOf(bundleId)]: copies })
  }

  /** Written whole, then kept (a write that fails changes nothing here either). */
  #write(apps: File["apps"]): void {
    // What reads back (never a file that would be set aside at the next start).
    const next: File = File.parse({ version: 1, apps })
    mkdirSync(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.${randomBytes(6).toString("hex")}.tmp`
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.#path)
    this.#file = next
  }
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
}

/** The same app: its developer (a team app updated is still theirs), or the same pinned build. */
export function sameSigner(a: Signer, b: Signer): boolean {
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
  | { status: "ready" | "updated"; app: DesktopApp }
  | { status: "allow" | "opens-changed" | "changed" | "not-found"; why: string }

/** The functions that look at an app (the runtime's; fakes in tests). */
export interface Looks {
  inspect: (path: string, signal?: AbortSignal) => Promise<DesktopApp>
  trial: (app: DesktopApp, opts: TrialOptions) => Promise<TrialOutcome>
}

/**
 * The project's desktop app's status, static only (opening the panel never launches anything): its
 * approval here first (what needs no look at the app), then the copy it uses, inspected, compared.
 */
export async function desktopStatus(
  entry: ElectronApp,
  scope: string,
  approvals: DesktopApprovals,
  looks: Pick<Looks, "inspect">,
): Promise<DesktopStatus> {
  const copy = approvals.copyFor(entry.bundleId, scope)
  if (copy === undefined) {
    return approvals.copies(entry.bundleId).length === 0
      ? { status: "allow", why: "not added on this Mac: add it from Applications to use it here" }
      : { status: "allow", why: "not allowed in this project yet: pick it to allow it here" }
  }
  if (copy.scopes[scope]?.opens !== opensOf(entry)) {
    return {
      status: "opens-changed",
      why: "the project changed what it opens with it: allow it again",
    }
  }
  let now: DesktopApp
  try {
    now = await looks.inspect(copy.path)
  } catch (error) {
    if (!existsSync(copy.path)) {
      return { status: "not-found", why: `not at ${copy.path} any more: add it again` }
    }
    return { status: "changed", why: (error as Error).message }
  }
  if (keyOf(now.bundleId) !== keyOf(entry.bundleId) || !sameSigner(copy.signer, now.signer)) {
    return { status: "changed", why: "another app is there now (or another build): add it again" }
  }
  return versionOf(now) !== copy.scopes[scope]?.version && now.signer.kind === "team"
    ? { status: "updated", app: now }
    : { status: "ready", app: now }
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

/** The app written to the project as `name` (refused by the project's own rules: said in words). */
function save(opened: OpenedProject, name: string, entry: ElectronApp): void {
  try {
    saveProject(opened, { ...opened.project, apps: { ...opened.project.apps, [name]: entry } })
  } catch (error) {
    // Only the project's rules reworded (a file changed on disk, a write failed: said as is).
    if ((error as Error).name !== "ZodError") throw error
    const issue = (error as { issues?: { message: string }[] }).issues?.[0]?.message
    throw new Error(`the project can't take it so${issue === undefined ? "" : ` (${issue})`}`, {
      cause: error,
    })
  }
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

/**
 * What the add flow needs of the app around it (main's; a fake in tests): read fresh at each step,
 * never a snapshot.
 */
export interface AddHost {
  /** The open project's session (none when no project is open). */
  session(): string | undefined
  opened(): OpenedProject | null
  /** Why nothing may change now (Kif working), or undefined. */
  busy(): string | undefined
  /** The app the user picks (main's dialog): undefined when cancelled. */
  pickApp(): Promise<string | undefined>
  /** The app approved for this project with what it opens. */
  approve(app: DesktopApp, opened: OpenedProject, opens: string): void
  /** The project's apps changed (its agent and the window told, if it's still the open one). */
  changed(opened: OpenedProject): void
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
  /** The sites it runs with (the project's, and any the user allowed after a trial named one). */
  origins: string[]
  /** Sites the user allowed in its checks (written to the project with it). */
  allowed: string[]
  /** A trial worked with the sites it runs with now (they changed since: not tried). */
  tried: boolean
  trial: AbortController | undefined
  adding: boolean
  /** Ends what's under way for it (its add's look at the app) when it's dropped. */
  stopping: AbortController
}

/** Refused: said to the user as is. */
const refused = (why: string) => new Error(why)
const GONE = "that app isn't being added any more: pick it again"

/**
 * The add flow, owned whole (PR 3b-2, redesigned after three review rounds): the app picked (main's
 * dialog; its path stays here: the window has a token), inspected, tried confined, added. One
 * gate before every change and after every wait: the add still under way, its window's, its
 * project the open one, Kif not working. A project switch ends every add at once (main's hook);
 * the gate is the guarantee whatever path changed it.
 */
export class DesktopAdds {
  readonly #pending = new Map<string, Pending>()
  /** Each window's pick in progress (a cancel ends it: its answer dropped). */
  readonly #picks = new Map<number, { generation: number; stopping: AbortController }>()
  #generation = 0
  readonly #looks: Looks
  readonly #host: AddHost
  readonly #workDir: string | undefined

  constructor(looks: Looks, host: AddHost, workDir?: string) {
    this.#looks = looks
    this.#host = host
    this.#workDir = workDir
  }

  /**
   * The user picks an app (one pick per window at a time), inspected: its card, null when the
   * dialog was cancelled or the pick given up meanwhile; refused: thrown, said.
   */
  async pick(owner: number, session: string): Promise<DesktopCard | null> {
    if (this.#picks.has(owner)) throw refused("an app is being picked already")
    this.#current(session)
    this.dropFor(owner)
    const generation = ++this.#generation
    const stopping = new AbortController()
    this.#picks.set(owner, { generation, stopping })
    const still = () =>
      this.#picks.get(owner)?.generation === generation && this.#isCurrent(session)
    try {
      const path = await this.#host.pickApp()
      if (path === undefined || !still()) return null
      let app: DesktopApp
      try {
        app = await this.#looks.inspect(path, stopping.signal)
      } catch (error) {
        if (stopping.signal.aborted) return null
        throw error
      }
      if (!still()) return null
      this.#current(session)
      const opened = this.#host.opened()
      if (opened === null) return null
      const named = Object.entries(opened.project.apps).find(
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
        allowed: [],
        tried: false,
        trial: undefined,
        adding: false,
        stopping: new AbortController(),
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
    } finally {
      if (this.#picks.get(owner)?.generation === generation) this.#picks.delete(owner)
    }
  }

  /**
   * The picked app tried, confined. `allowSite`: with the site the last trial named (kept here),
   * as the app's own: tried again before it can be added.
   */
  async check(
    owner: number,
    session: string,
    token: string,
    allowSite: boolean,
  ): Promise<TrialOutcome> {
    const pending = this.#own(owner, session, token)
    if (pending.trial !== undefined) throw refused("it's being checked already")
    if (pending.adding) throw refused("it's being added already")
    if (allowSite) {
      if (pending.site === undefined) throw refused("no site to allow: check it first")
      pending.origins = [...new Set([...pending.origins, pending.site])]
      pending.allowed = [...new Set([...pending.allowed, pending.site])]
    }
    // What it runs with now is untried until this trial says so.
    pending.tried = false
    const stopping = new AbortController()
    pending.trial = stopping
    try {
      const outcome = await this.#looks.trial(pending.app, {
        origins: pending.origins,
        signal: stopping.signal,
        ...(this.#workDir !== undefined && { workDir: this.#workDir }),
      })
      this.#own(owner, session, token)
      pending.tried = "ok" in outcome
      pending.site = "site" in outcome ? outcome.site : undefined
      return outcome
    } finally {
      pending.trial = undefined
    }
  }

  /**
   * The tried app added to the project (or, named already, allowed here): its build checked again
   * (the one tried), the project written (its changed-on-disk refusal), then approved. Once the
   * project is written the add is done (an approval that fails then: said, allowed again later).
   */
  async add(owner: number, session: string, token: string): Promise<string> {
    const pending = this.#own(owner, session, token)
    if (pending.trial !== undefined) throw refused("it's being checked: wait for it")
    if (!pending.tried) throw refused("check it first: it's added once it ran here")
    if (pending.adding) throw refused("it's being added already")
    pending.adding = true
    try {
      const now = await this.#looks
        .inspect(pending.app.path, pending.stopping.signal)
        .catch((error: unknown) => {
          // Given up meanwhile: said as such (the gate's words); else its own reason.
          if (pending.stopping.signal.aborted) this.#own(owner, session, token)
          throw error
        })
      this.#own(owner, session, token)
      if (!sameSigner(now.signer, pending.app.signer)) {
        throw refused("the app changed since it was checked: pick it again")
      }
      const opened = this.#host.opened()
      if (opened === null) throw refused(GONE)
      let name = pending.existing
      let entry: ElectronApp
      if (name !== undefined) {
        const named = opened.project.apps[name]
        // What the user saw at the pick, still (a project changed meanwhile: never approved untried).
        if (named?.kind !== "electron" || opensOf(named) !== pending.opensAtPick) {
          throw refused("the project changed meanwhile: pick it again")
        }
        entry = named
        // A site allowed in a check: the project's too (its runs need it).
        if (pending.allowed.length > 0) {
          entry = {
            ...named,
            origins: [...new Set([...(named.origins ?? []), ...pending.allowed])],
          }
          save(opened, name, entry)
        }
      } else {
        name = appNameFor(now.name, Object.keys(opened.project.apps))
        entry = {
          kind: "electron",
          bundleId: now.bundleId,
          ...(pending.origins.length > 0 && { origins: pending.origins }),
          viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        }
        save(opened, name, entry)
      }
      // Written: done, whatever follows.
      this.#pending.delete(token)
      this.#host.changed(opened)
      try {
        // The build that was tried (a newer one since, same developer: "updated", tried at its run).
        this.#host.approve(pending.app, opened, opensOf(entry))
      } catch (error) {
        throw refused(
          `added as ${name}, but not approved on this Mac (${(error as Error).message}): pick it again to allow it`,
        )
      }
      return name
    } finally {
      pending.adding = false
    }
  }

  /** A window's pick and add given up (cancelled, the window closed or reloaded). */
  dropFor(owner: number): void {
    this.#picks.get(owner)?.stopping.abort()
    this.#picks.delete(owner)
    for (const [token, pending] of this.#pending) {
      if (pending.owner !== owner) continue
      pending.trial?.abort()
      pending.stopping.abort()
      this.#pending.delete(token)
    }
  }

  /** Every pick and add given up, their trials ended (a project switch, a quit). */
  dropAll(): void {
    for (const pick of this.#picks.values()) pick.stopping.abort()
    this.#picks.clear()
    for (const pending of this.#pending.values()) {
      pending.trial?.abort()
      pending.stopping.abort()
    }
    this.#pending.clear()
  }

  #isCurrent(session: string): boolean {
    return this.#host.session() === session
  }

  /** The session the window acts in is the open project's, and nothing may stop a change now. */
  #current(session: string): void {
    if (!this.#isCurrent(session)) throw refused("the project changed: pick the app again")
    const busy = this.#host.busy()
    if (busy !== undefined) throw refused(busy)
  }

  /** The gate: this window's add, still under way, its project the open one, Kif not working. */
  #own(owner: number, session: string, token: string): Pending {
    const pending = this.#pending.get(token)
    if (pending !== undefined && !this.#isCurrent(pending.session)) {
      pending.trial?.abort()
      pending.stopping.abort()
      this.#pending.delete(token)
    }
    const still = this.#pending.get(token)
    if (still === undefined || still.owner !== owner || still.session !== session)
      throw refused(GONE)
    const busy = this.#host.busy()
    if (busy !== undefined) throw refused(busy)
    return still
  }
}

/** The add flow's host from the workspace (main's, and tests' with a real one). */
export function addHostOf(
  workspace: {
    readonly session: string | undefined
    readonly opened: OpenedProject | null
    readonly agent: { readonly running: boolean } | undefined
  },
  deps: Pick<AddHost, "pickApp" | "approve" | "changed">,
): AddHost {
  return {
    session: () => workspace.session,
    opened: () => workspace.opened,
    busy: () => (workspace.agent?.running === true ? "Kif is working: stop it first" : undefined),
    ...deps,
  }
}
