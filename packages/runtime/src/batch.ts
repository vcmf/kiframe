import {
  Action,
  startAppOf,
  unknownApps,
  type ProjectConfig,
  type Scenario,
  SceneId,
} from "@kiframe/schema"
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright"
import { StepError } from "./errors.ts"
import { recordScenario, type RecordOptions, type Take } from "./recorder.ts"
import { appAtOrigin } from "./run/apps.ts"
import type { SessionLanding } from "./run/context.ts"
import { secretsOf } from "./secret-state.ts"

// A recording batch (APPROACHES §7.2): several scenes of one project, one after another. Each scene
// gets a fresh browser context (nothing leaks from one take to the next but the session), and
// session presets (logins) run once: the context's state is saved when they're done and the next
// scenes using them start from it, skipping them.

export interface BatchScene {
  scenario: Scenario
  /** The scene's take directory (see `RecordOptions.outDir`). */
  outDir: string
  /** The host's id for this scene: the approval keys of its own secret steps (never shared). */
  sceneId: string
}

export interface BatchOptions extends Omit<
  RecordOptions,
  "outDir" | "skipSessionPresets" | "onSessionReady" | "sessionLandings" | "sceneId"
> {
  /** For every scene's context. Default: the project's viewport and device scale factor. */
  context?: Omit<BrowserContextOptions, "storageState">
  /** Called with each scene's result, as soon as it's known. Must not throw. */
  onScene?: (index: number, result: BatchResult) => void
}

export type BatchResult = { ok: true; take: Take } | { ok: false; error: unknown }

/**
 * Where a session preset ended, as a way back (its app and a relative path): only on a listed
 * app's own origin (a `goto` there can't reach a www. alias), a valid relative `goto`.
 */
export function landingOf(project: ProjectConfig, page: Page): SessionLanding | undefined {
  const url = new URL(page.url())
  const path = `${url.pathname}${url.search}${url.hash}`
  const app = appAtOrigin(project.apps, url.href)
  return app !== undefined && Action.safeParse({ action: "goto", app, url: path }).success
    ? { app, url: path }
    : undefined
}

/** The session presets a scene's setup uses. */
export function sessionPresetsOf(scenario: Scenario, project: ProjectConfig): string[] {
  return (scenario.setup ?? []).flatMap((item) =>
    "preset" in item &&
    Object.hasOwn(project.presets, item.preset) &&
    project.presets[item.preset]?.session === true
      ? [item.preset]
      : [],
  )
}

/**
 * Records scenes in order. A failed scene doesn't stop the batch. The saved session lives in
 * memory only, for this batch (never on disk: it holds the login's cookies).
 */
export async function recordBatch(
  browser: Browser,
  scenes: readonly BatchScene[],
  project: ProjectConfig,
  options: BatchOptions = {},
): Promise<BatchResult[]> {
  const { context: contextOptions, onScene, ...record } = options
  // Each scene's own approval keys (§3 A1): a scene with an invalid id, or an earlier scene's, fails.
  const ids = new Set<string>()
  // Never clipboard access for the page (SECRETS-DESIGN §3 A5).
  const clipboard = (contextOptions?.permissions ?? []).filter((p) => p.startsWith("clipboard"))
  if (clipboard.length > 0) {
    throw new Error(`recording contexts never get clipboard permissions (${clipboard.join(", ")})`)
  }
  let state: BrowserContextOptions["storageState"]
  // The session presets the saved state holds, and the page each one ended on (in which app).
  let landings: Record<string, SessionLanding> = {}
  const results: BatchResult[] = []
  const seenValues = new Set<string>()
  const report = (index: number, result: BatchResult) => {
    results.push(result)
    try {
      onScene?.(index, result)
    } catch {
      // a progress callback never stops the batch
    }
  }
  for (const [index, scene] of scenes.entries()) {
    // Stopped: the scenes left aren't recorded (each says so).
    if (options.signal?.aborted === true) {
      const step = { phase: "setup" as const, index: 0, action: "start the scene" }
      report(index, { ok: false, error: new StepError(step, "stopped", "the batch was stopped") })
      continue
    }
    const uses = sessionPresetsOf(scene.scenario, project)
    // Only a scene using the saved session starts from it (a signed-out scene stays signed out).
    // And only with a page to go back to for each (the setup may rely on it).
    const reuse =
      state !== undefined && uses.length > 0 && uses.every((p) => Object.hasOwn(landings, p))
    const saved = reuse ? state : undefined
    const savedHere = new Set<string>()
    let context: BrowserContext | undefined
    let result: BatchResult
    try {
      // Before anything runs (a login, risky setup): a bad id would only surface at a secret step.
      if (!SceneId.safeParse(scene.sceneId).success) {
        throw new Error(`scene id "${scene.sceneId}" isn't a scene id (kebab-case)`)
      }
      if (ids.has(scene.sceneId)) {
        throw new Error(`an earlier scene of the batch has the id "${scene.sceneId}"`)
      }
      ids.add(scene.sceneId)
      // An app it names that the project doesn't list: refused as a single run refuses it.
      const unknown = unknownApps(scene.scenario, project)
      if (unknown.length > 0) {
        throw new StepError(
          { phase: "setup", index: 0, action: "setup" },
          "invalid-setup",
          unknown.join("; "),
        )
      }
      // Filmed at the size of the app the scene starts in (one size per take).
      const start = startAppOf(scene.scenario, project)
      context = await browser.newContext({
        viewport: { width: start.app.viewport.width, height: start.app.viewport.height },
        deviceScaleFactor: start.app.viewport.deviceScaleFactor,
        ...contextOptions,
        ...(saved !== undefined && { storageState: saved }),
      })
      const current = context
      const page = await current.newPage()
      const take = await recordScenario(page, scene.scenario, project, {
        ...record,
        fresh: true,
        outDir: scene.outDir,
        sceneId: scene.sceneId,
        // The values earlier scenes resolved (they share a session): a scene whose login was
        // skipped still refuses paste and blurs "Signed in as bob@acme.com" (§5 R6).
        knownSecretValues: [...(record.knownSecretValues ?? []), ...seenValues],
        skipSessionPresets: reuse ? uses : [],
        sessionLandings: landings,
        onSessionReady: async (preset, at, held) => {
          // A reuse held: its state renewed (a spent refresh token), its landings as they were.
          if (held) {
            // Never the scene's failure: the state as it was (a snapshot that can't be taken).
            state = await current.storageState({ indexedDB: true }).catch(() => state)
            return
          }
          // A fresh login (a reusing scene's held presets returned above). Its fresh
          // context holds only what it logged into: sessions saved by earlier scenes are gone.
          state = await current.storageState({ indexedDB: true })
          if (savedHere.size === 0) landings = {}
          savedHere.add(preset)
          const landing = landingOf(project, at)
          if (landing !== undefined) landings[preset] = landing
        },
      })
      result = { ok: true, take }
    } catch (error) {
      result = { ok: false, error }
      // A step failing on the reused session may be the session (expired, signed out): the next
      // scene logs in again rather than failing the same way. Not for a setup error or a file one.
      // Not a refusal: approvals and risky steps say nothing about the session.
      const notSession = [
        "invalid-setup",
        "secret-refused",
        "secret-declined",
        "risky-not-approved",
        // A page off the apps: the scene's doing, never the session's.
        "off-app",
        "stopped",
      ]
      if (reuse && error instanceof StepError && !notSession.includes(error.reason)) {
        state = undefined
        landings = {}
      }
    } finally {
      if (context !== undefined) for (const v of secretsOf(context).values) seenValues.add(v)
      await context?.close().catch(() => undefined)
    }
    report(index, result)
  }
  return results
}
