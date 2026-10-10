// A desktop app launched for the agent (PR 4, design reviewed 2026-10-10): only an app approved
// on this Mac for this project and what it opens, from the copy that was approved. One the same
// developer updated is tried confined first, quietly (the user's decision, 2026-10-09), and that
// build approved for the project only if nothing changed meanwhile. Anything else is refused for
// the user to settle in the Apps panel (never something the agent can fix).
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { OpenedProject } from "@kiframe/project"
import type { DesktopApp, ElectronLaunch, ElectronTarget, TrialOutcome } from "@kiframe/runtime"
import type { ElectronApp, TakeMeta } from "@kiframe/schema"
import {
  type DesktopApprovals,
  desktopStatus,
  type Looks,
  opensOf,
  sameSigner,
  versionOf,
} from "./desktop-apps.ts"

/** What a take keeps of the app it filmed: its build and what it opened (the take's own shape). */
export type AppBuild = NonNullable<TakeMeta["appBuild"]>

/** A launch refused: the user settles it (the Apps panel), the agent says so and never retries. */
export class DesktopRefused extends Error {
  readonly needsUser = true
}

export interface LauncherDeps {
  approvals: () => DesktopApprovals
  looks: Looks
  launch: (opts: ElectronLaunch) => Promise<ElectronTarget>
  /** The open project, read at each step (a switch meanwhile: refused). */
  opened: () => OpenedProject | null
  scope: (dir: string) => string
  workDir?: string
}

/**
 * Launches the project's desktop apps, each from its approval: one quiet trial of an updated
 * build at a time per app and project (two launches meanwhile share it).
 */
export class DesktopLauncher {
  readonly #deps: LauncherDeps
  readonly #trials = new Map<string, Promise<void>>()

  constructor(deps: LauncherDeps) {
    this.#deps = deps
  }

  /** The app `name` of the open project, launched confined; refused: `DesktopRefused`. */
  async launch(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ target: ElectronTarget; build: AppBuild }> {
    const opened = this.#deps.opened()
    const entry = opened?.project.apps[name]
    if (opened === null || entry?.kind !== "electron") {
      throw new DesktopRefused(`"${name}" isn't a desktop app of the open project`)
    }
    const scope = this.#deps.scope(opened.dir)
    let status = await desktopStatus(entry, scope, this.#deps.approvals(), this.#deps.looks, signal)
    if (status.status === "updated") {
      const tried = status.app
      await waitFor(this.#quietTrial(name, entry, scope, tried), signal)
      // The build that launches is the build that was tried (an update landing meanwhile: never).
      const now = await this.#deps.looks.inspect(tried.path, signal)
      if (versionOf(now) !== versionOf(tried) || !sameSigner(now.signer, tried.signer)) {
        throw new DesktopRefused(
          `${name} updated again while it was checked: start again (it's checked once more)`,
        )
      }
      status = { status: "ready", app: tried }
    }
    if ("why" in status) throw new DesktopRefused(`${name}: ${status.why} (in the Apps panel)`)
    signal?.throwIfAborted()
    // Still approved here, the project still open and naming it the same (removed or switched
    // while it was looked at: never launched).
    this.#still(name, entry, opened, scope, status.app)
    const app = status.app
    const files = join(opened.dir, "files")
    const target = await this.#deps.launch({
      executable: app.executable,
      bundle: app.path,
      ...(existsSync(files) && { files }),
      ...(entry.args !== undefined && { args: entry.args }),
      ...(entry.origins !== undefined && { origins: entry.origins }),
      viewport: entry.viewport,
      ...(signal !== undefined && { signal }),
      ...(this.#deps.workDir !== undefined && { workDir: this.#deps.workDir }),
    })
    const version = versionOf(app)
    return { target, build: { ...(version !== undefined && { version }), opens: opensOf(entry) } }
  }

  /** The approval and the project as they were looked at, still (else refused, nothing written). */
  #still(
    name: string,
    entry: ElectronApp,
    opened: OpenedProject,
    scope: string,
    app: DesktopApp,
  ): void {
    const copy = this.#deps.approvals().copyFor(entry.bundleId, scope)
    const now = this.#deps.opened()
    const named = now?.project.apps[name]
    const same =
      copy !== undefined &&
      copy.path === app.path &&
      sameSigner(copy.signer, app.signer) &&
      copy.scopes[scope]?.opens === opensOf(entry) &&
      now === opened &&
      named?.kind === "electron" &&
      opensOf(named) === opensOf(entry)
    if (!same) {
      throw new DesktopRefused(`${name} changed meanwhile: allow it again (in the Apps panel)`)
    }
  }

  /**
   * An updated build tried confined (one trial per build, app and project: launches meanwhile wait
   * for it; a launch stopped stops only its own wait), then approved for this project
   * compare-and-set. Its own stop: none (it ends by itself, bounded).
   */
  #quietTrial(name: string, entry: ElectronApp, scope: string, app: DesktopApp): Promise<void> {
    const opened = this.#deps.opened()
    const build =
      app.signer.kind === "team" ? `${app.signer.team} ${versionOf(app) ?? ""}` : app.signer.digest
    const key = `${entry.bundleId.toLowerCase()} ${scope} ${build}`
    const running = this.#trials.get(key)
    if (running !== undefined) return running
    const trial = (async () => {
      const outcome = await this.#deps.looks.trial(app, {
        origins: entry.origins ?? [],
        ...(this.#deps.workDir !== undefined && { workDir: this.#deps.workDir }),
      })
      if (!("ok" in outcome)) throw new DesktopRefused(`${name} updated: ${refusalOf(outcome)}`)
      if (opened === null)
        throw new DesktopRefused(`${name} changed meanwhile: allow it again (in the Apps panel)`)
      this.#still(name, entry, opened, scope, app)
      try {
        this.#deps.approvals().approve(app, scope, opensOf(entry))
      } catch (error) {
        throw new DesktopRefused(
          `${name} ran confined but couldn't be approved here (${(error as Error).message})`,
        )
      }
    })()
    this.#trials.set(key, trial)
    void trial.finally(() => this.#trials.delete(key)).catch(() => undefined)
    return trial
  }
}

/** What a quiet trial that didn't work says (in words the user acts on). */
function refusalOf(outcome: Exclude<TrialOutcome, { ok: true }>): string {
  if ("site" in outcome) {
    return `its window is now the site ${outcome.site}: allow it again (in the Apps panel)`
  }
  if ("quit" in outcome)
    return "it quit at once when tried confined: check it again (in the Apps panel)"
  return `it couldn't be tried confined (${outcome.failed}): check it again (in the Apps panel)`
}

/** A wait ended by its own stop only (what it waits for goes on for others). */
function waitFor<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason as Error)
    signal.addEventListener("abort", stop, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}
