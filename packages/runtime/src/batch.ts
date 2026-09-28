import type { ProjectConfig, ResolvedEnvironment, Scenario } from "@kiframe/schema"
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright"
import type { StepRef } from "./errors.ts"
import { recordScenario, type RecordOptions, type Take } from "./recorder.ts"

// A recording batch (APPROACHES §7.3): several scenes of one project, one after another. Each scene
// gets a fresh browser context (nothing leaks from one take to the next but the session), and
// session presets (logins) run once: the context's state is saved when they're done and the next
// scenes start from it, skipping them.

/**
 * The approval policy of an environment: a risky teardown step (and an `ensure` cleanup, which
 * runs the teardown) is pre-approved where the org allows it (a sandbox's `preApproveTeardown`);
 * everything else goes to `ask`, and without `ask` it's refused.
 */
export function approvalPolicy(
  environment: Pick<ResolvedEnvironment, "sandbox" | "preApproveTeardown">,
  ask?: (step: StepRef) => boolean | Promise<boolean>,
): (step: StepRef) => boolean | Promise<boolean> {
  const teardownApproved = environment.sandbox && environment.preApproveTeardown
  return (step) => {
    const cleanup =
      step.interrupt === undefined &&
      (step.phase === "teardown" || (step.phase === "setup" && step.action.startsWith("ensure: ")))
    if (teardownApproved && cleanup) return true
    return ask?.(step) ?? false
  }
}

export interface BatchScene {
  scenario: Scenario
  /** The scene's take directory (see `RecordOptions.outDir`). */
  outDir: string
}

export interface BatchOptions extends Omit<
  RecordOptions,
  "outDir" | "skipSessionPresets" | "onSessionReady"
> {
  /** For every scene's context (device scale factor…). The viewport is the project's. */
  context?: Omit<BrowserContextOptions, "storageState" | "viewport">
  /** Called with each scene's result, as soon as it's known. */
  onScene?: (index: number, result: BatchResult) => void
}

export type BatchResult = { ok: true; take: Take } | { ok: false; error: unknown }

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
  let state: BrowserContextOptions["storageState"]
  const ready = new Set<string>()
  const results: BatchResult[] = []
  for (const [index, scene] of scenes.entries()) {
    const skipped = [...ready]
    const context: BrowserContext = await browser.newContext({
      ...contextOptions,
      viewport: {
        width: project.target.viewport.width,
        height: project.target.viewport.height,
      },
      ...(state !== undefined && { storageState: state }),
    })
    let result: BatchResult
    try {
      const page = await context.newPage()
      const take = await recordScenario(page, scene.scenario, project, {
        ...record,
        outDir: scene.outDir,
        skipSessionPresets: skipped,
        onSessionReady: async (preset) => {
          state = await context.storageState({ indexedDB: true })
          ready.add(preset)
        },
      })
      result = { ok: true, take }
    } catch (error) {
      result = { ok: false, error }
      // The saved session may be why (expired, signed out by the app): the next scene logs in
      // again rather than failing the same way.
      if (skipped.length > 0) {
        state = undefined
        ready.clear()
      }
    } finally {
      await context.close().catch(() => undefined)
    }
    results.push(result)
    onScene?.(index, result)
  }
  return results
}
