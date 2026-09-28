import {
  Action,
  type ProjectConfig,
  type ResolvedEnvironment,
  type Scenario,
} from "@kiframe/schema"
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright"
import { StepError, type StepRef } from "./errors.ts"
import { recordScenario, type RecordOptions, type Take } from "./recorder.ts"

// A recording batch (APPROACHES §7.2): several scenes of one project, one after another. Each scene
// gets a fresh browser context (nothing leaks from one take to the next but the session), and
// session presets (logins) run once: the context's state is saved when they're done and the next
// scenes using them start from it, skipping them.

/**
 * The approval policy of an environment: a risky cleanup (a teardown step, or the teardown an
 * `ensure` runs: `StepRef.cleanup`) is pre-approved where the org allows it (a sandbox's
 * `preApproveTeardown`); everything else goes to `ask`, and without `ask` it's refused.
 */
export function approvalPolicy(
  environment: Pick<ResolvedEnvironment, "sandbox" | "preApproveTeardown">,
  ask?: (step: StepRef) => boolean | Promise<boolean>,
): (step: StepRef) => boolean | Promise<boolean> {
  const teardownApproved = environment.sandbox && environment.preApproveTeardown
  return (step) => {
    if (teardownApproved && step.cleanup === true && step.interrupt === undefined) return true
    return ask?.(step) ?? false
  }
}

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
  /**
   * The environment the batch runs against: risky steps go through its `approvalPolicy`, with
   * `approveRisky` as the way to ask.
   */
  environment?: Pick<ResolvedEnvironment, "sandbox" | "preApproveTeardown">
  /** For every scene's context. Default: the project's viewport and device scale factor. */
  context?: Omit<BrowserContextOptions, "storageState">
  /** Called with each scene's result, as soon as it's known. Must not throw. */
  onScene?: (index: number, result: BatchResult) => void
}

export type BatchResult = { ok: true; take: Take } | { ok: false; error: unknown }

/** The session presets a scene's setup uses. */
function sessionPresetsOf(scenario: Scenario, project: ProjectConfig): string[] {
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
  const { context: contextOptions, onScene, environment, ...record } = options
  if (environment !== undefined) {
    record.approveRisky = approvalPolicy(environment, options.approveRisky)
  }
  const origin = new URL(project.target.url).origin
  let state: BrowserContextOptions["storageState"]
  // The session presets the saved state holds, and the page each one ended on.
  let landings: Record<string, string> = {}
  const results: BatchResult[] = []
  for (const [index, scene] of scenes.entries()) {
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
      context = await browser.newContext({
        viewport: {
          width: project.target.viewport.width,
          height: project.target.viewport.height,
        },
        deviceScaleFactor: project.target.viewport.deviceScaleFactor,
        ...contextOptions,
        ...(saved !== undefined && { storageState: saved }),
      })
      const current = context
      const page = await current.newPage()
      const take = await recordScenario(page, scene.scenario, project, {
        ...record,
        outDir: scene.outDir,
        sceneId: scene.sceneId,
        skipSessionPresets: reuse ? uses : [],
        sessionLandings: landings,
        onSessionReady: async (preset, at) => {
          // Only fresh-login scenes get here (a reusing one skips its session presets). Its fresh
          // context holds only what it logged into: sessions saved by earlier scenes are gone.
          state = await current.storageState({ indexedDB: true })
          if (savedHere.size === 0) landings = {}
          savedHere.add(preset)
          const url = new URL(at.url())
          const landing = `${url.pathname}${url.search}${url.hash}`
          // Kept only if the runner can go back there (same origin, a valid relative `goto`).
          if (url.origin === origin && Action.safeParse({ action: "goto", url: landing }).success) {
            landings[preset] = landing
          }
        },
      })
      result = { ok: true, take }
    } catch (error) {
      result = { ok: false, error }
      // A step failing on the reused session may be the session (expired, signed out): the next
      // scene logs in again rather than failing the same way. Not for a setup error or a file one.
      if (reuse && error instanceof StepError && error.reason !== "invalid-setup") {
        state = undefined
        landings = {}
      }
    } finally {
      await context?.close().catch(() => undefined)
    }
    results.push(result)
    try {
      onScene?.(index, result)
    } catch {
      // a progress callback never stops the batch
    }
  }
  return results
}
