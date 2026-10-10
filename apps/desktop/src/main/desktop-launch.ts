// A desktop app launched for the agent (PR 4, design reviewed 2026-10-10): only an app approved
// on this Mac for this project and what it opens, from the copy that was approved. One the same
// developer updated is tried confined first, quietly (the user's decision, 2026-10-09), and that
// build approved for the project only if nothing changed meanwhile. Anything else is refused for
// the user to settle in the Apps panel (never something the agent can fix).
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { OpenedProject } from "@kiframe/project"
import type { DesktopApp, ElectronLaunch, ElectronTarget } from "@kiframe/runtime"
import type { ElectronApp } from "@kiframe/schema"
import {
  type DesktopApprovals,
  desktopStatus,
  type Looks,
  opensOf,
  sameSigner,
  versionOf,
} from "./desktop-apps.ts"

/** What a take keeps of the app it filmed: its build and what it opened. */
export interface AppBuild {
  version?: string
  opens: string
}

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
    let status = await desktopStatus(entry, scope, this.#deps.approvals(), this.#deps.looks)
    if (status.status === "updated") {
      await this.#quietTrial(name, entry, opened, scope, status.app, signal)
      status = { status: "ready", app: status.app }
    }
    if ("why" in status) throw new DesktopRefused(`${name}: ${status.why} (in the Apps panel)`)
    signal?.throwIfAborted()
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

  /**
   * An updated build tried confined, then approved for this project, compare-and-set: the copy
   * approved still the same place, developer and opens, the project still the open one naming the
   * app the same. Two launches meanwhile wait for the same trial.
   */
  #quietTrial(
    name: string,
    entry: ElectronApp,
    opened: OpenedProject,
    scope: string,
    app: DesktopApp,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const key = `${entry.bundleId.toLowerCase()} ${scope}`
    const running = this.#trials.get(key)
    if (running !== undefined) return running
    const trial = (async () => {
      const outcome = await this.#deps.looks.trial(app, {
        origins: entry.origins ?? [],
        ...(signal !== undefined && { signal }),
        ...(this.#deps.workDir !== undefined && { workDir: this.#deps.workDir }),
      })
      if (!("ok" in outcome)) {
        throw new DesktopRefused(
          `${name} updated and no longer runs confined: check it again (in the Apps panel)`,
        )
      }
      const approvals = this.#deps.approvals()
      const copy = approvals.copyFor(entry.bundleId, scope)
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
        throw new DesktopRefused(
          `${name} changed while it was checked: allow it again (in the Apps panel)`,
        )
      }
      approvals.approve(app, scope, opensOf(entry))
    })()
    this.#trials.set(key, trial)
    void trial.finally(() => this.#trials.delete(key)).catch(() => undefined)
    return trial
  }
}
