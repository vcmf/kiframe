import type { ProjectConfig, ResolvedEnvironment, Scenario } from "@kiframe/schema"
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright"
import { StepError, type StepRef } from "./errors.ts"
import { recordScenario, type RecordOptions, type Take } from "./recorder.ts"

// A recording batch (APPROACHES §7.2): several scenes of one project, one after another. Each scene
// gets a fresh browser context (nothing leaks from one take to the next but the session), and
// session presets (logins) run once: the context's state is saved when they're done and the next
// scenes using them start from it, skipping them.

/**
 * The approval policy of an environment: a risky teardown step (and an `ensure`'s teardown, labelled
 * `ensure: …`) is pre-approved where the org allows it (a sandbox's `preApproveTeardown`);
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
  "outDir" | "skipSessionPresets" | "onSessionReady" | "sessionLandings"
> {
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
  const { context: contextOptions, onScene, ...record } = options
  const origin = new URL(project.target.url).origin
  let state: BrowserContextOptions["storageState"]
  const ready = new Set<string>()
  const landings: Record<string, string> = {}
  const results: BatchResult[] = []
  for (const [index, scene] of scenes.entries()) {
    const uses = sessionPresetsOf(scene.scenario, project)
    // Only a scene using the saved session starts from it (a signed-out scene stays signed out).
    const reuse = state !== undefined && uses.length > 0 && uses.every((p) => ready.has(p))
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
        ...(reuse && state !== undefined && { storageState: state }),
      })
      const current = context
      const page = await current.newPage()
      const take = await recordScenario(page, scene.scenario, project, {
        ...record,
        outDir: scene.outDir,
        skipSessionPresets: reuse ? uses : [],
        sessionLandings: landings,
        onSessionReady: async (preset, at) => {
          state = await current.storageState({ indexedDB: true })
          ready.add(preset)
          const url = new URL(at.url())
          if (url.origin === origin) landings[preset] = `${url.pathname}${url.search}`
          else delete landings[preset]
        },
      })
      result = { ok: true, take }
    } catch (error) {
      result = { ok: false, error }
      // A step failing on the reused session may be the session (expired, signed out): the next
      // scene logs in again rather than failing the same way. Not for a setup error or a file one.
      if (reuse && error instanceof StepError && error.reason !== "invalid-setup") {
        state = undefined
        ready.clear()
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
