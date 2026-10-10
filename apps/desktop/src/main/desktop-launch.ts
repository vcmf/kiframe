// A desktop app launched for the agent (PR 4, design reviewed 2026-10-10): only an app approved
// on this Mac for this project and what it opens, from the copy that was approved. One the same
// developer updated is tried confined first, quietly (the user's decision, 2026-10-09), and that
// build approved for the project only if nothing changed meanwhile. Anything else is refused for
// the user to settle in the Apps panel (never something the agent can fix).
import { existsSync } from "node:fs"
import { homedir } from "node:os"
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
 * Launches the project's desktop apps, each from its approval (an updated build tried quietly by
 * the launch itself first).
 */
export class DesktopLauncher {
  readonly #deps: LauncherDeps
  #lifetime = new AbortController()

  constructor(deps: LauncherDeps) {
    this.#deps = deps
  }

  /** Every launch's quiet trial ended (a project switch, a quit): their confined apps killed. */
  stopAll(): void {
    this.#lifetime.abort()
    this.#lifetime = new AbortController()
  }

  /**
   * The app `name` of the open project, launched confined; refused (anything but a stop, said
   * without a local path: the agent reads it): `DesktopRefused`.
   */
  async launch(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ target: ElectronTarget; build: AppBuild }> {
    try {
      return await this.#launch(name, signal)
    } catch (error) {
      if (signal?.aborted === true) throw error
      // Its own paths named first (whole: spaces in them), then any other.
      const opened = this.#deps.opened()
      const entry = opened?.project.apps[name]
      const copy =
        opened !== null && entry?.kind === "electron"
          ? this.#deps.approvals().copyFor(entry.bundleId, this.#deps.scope(opened.dir))
          : undefined
      const known = [
        ...(copy !== undefined ? [copy.path] : []),
        ...(this.#deps.workDir !== undefined ? [this.#deps.workDir] : []),
        ...(opened !== null ? [opened.dir] : []),
        homedir(),
      ]
      const said = withoutPaths(error instanceof Error ? error.message : String(error), known)
      if (error instanceof DesktopRefused) throw new DesktopRefused(said)
      throw new DesktopRefused(`${name} couldn't be launched: ${said} (in the Apps panel)`)
    }
  }

  async #launch(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ target: ElectronTarget; build: AppBuild }> {
    const opened = this.#deps.opened()
    const entry = opened?.project.apps[name]
    if (opened === null || entry?.kind !== "electron") {
      throw new DesktopRefused(`"${name}" isn't a desktop app of the open project`)
    }
    const scope = this.#deps.scope(opened.dir)
    // The launcher's stop as it was when this launch began (a switch meanwhile ends it too).
    const lifetime = this.#lifetime.signal
    let status = await desktopStatus(entry, scope, this.#deps.approvals(), this.#deps.looks, signal)
    if (status.status === "updated") {
      signal?.throwIfAborted()
      const stops = signal === undefined ? lifetime : AbortSignal.any([signal, lifetime])
      await this.#quietTrial(name, entry, opened, scope, status.app, stops, signal)
      // Asked again: what's there now must be the build just approved (an update landing during
      // the trial, an app moved or replaced: refused for the user, never launched untried).
      status = await desktopStatus(entry, scope, this.#deps.approvals(), this.#deps.looks, signal)
      if (status.status === "updated") {
        throw new DesktopRefused(`${name} updated again while it was checked: start again`)
      }
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
    approvedBuild = true,
  ): void {
    const copy = this.#deps.approvals().copyFor(entry.bundleId, scope)
    const now = this.#deps.opened()
    const named = now?.project.apps[name]
    const same =
      copy !== undefined &&
      copy.path === app.path &&
      sameSigner(copy.signer, app.signer) &&
      copy.scopes[scope]?.opens === opensOf(entry) &&
      (!approvedBuild ||
        app.signer.kind !== "team" ||
        copy.scopes[scope]?.version === versionOf(app)) &&
      now === opened &&
      named?.kind === "electron" &&
      opensOf(named) === opensOf(entry)
    if (!same) {
      throw new DesktopRefused(`${name} changed meanwhile: allow it again (in the Apps panel)`)
    }
  }

  /**
   * An updated build tried confined by this launch, then approved for its project compare-and-set
   * (the same copy, developer and opens, the project still the one it looked at: two launches that
   * both tried it approve the same thing; anything changed: refused). Its stop: the launch's own
   * (thrown as it is), or the launcher's (refused: the project closed).
   */
  async #quietTrial(
    name: string,
    entry: ElectronApp,
    opened: OpenedProject,
    scope: string,
    app: DesktopApp,
    stops: AbortSignal,
    own: AbortSignal | undefined,
  ): Promise<void> {
    let outcome: TrialOutcome
    try {
      outcome = await this.#deps.looks.trial(app, {
        origins: entry.origins ?? [],
        signal: stops,
        ...(this.#deps.workDir !== undefined && { workDir: this.#deps.workDir }),
      })
    } catch (error) {
      if (own?.aborted === true) throw error
      if (stops.aborted)
        throw new DesktopRefused(`${name}: the project closed while it was checked`)
      throw error
    }
    if (stops.aborted && own?.aborted !== true) {
      throw new DesktopRefused(`${name}: the project closed while it was checked`)
    }
    own?.throwIfAborted()
    if (!("ok" in outcome)) throw new DesktopRefused(`${name} updated: ${refusalOf(outcome)}`)
    this.#still(name, entry, opened, scope, app, false)
    try {
      this.#deps.approvals().approve(app, scope, opensOf(entry))
    } catch (error) {
      throw new DesktopRefused(
        `${name} ran confined but couldn't be approved here (${(error as Error).message})`,
      )
    }
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

/** A message with every local path (a user's folder, an app's place) taken out. */
export function withoutPaths(text: string, known: readonly string[] = []): string {
  let said = text
  for (const path of [...known].sort((a, b) => b.length - a.length)) {
    if (path.length > 1) said = said.split(path).join("<a local path>")
  }
  return said.replace(/(?<![:\w/.>])(?:~\/|\/)(?:[^\s'"()/]+\/)+[^\s'"(),]*/g, "<a local path>")
}
