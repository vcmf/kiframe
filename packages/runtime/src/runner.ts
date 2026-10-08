import {
  presetRefs,
  type ProjectConfig,
  type Scenario,
  startAppOf,
  unknownApps,
} from "@kiframe/schema"
import type { Frame, Page } from "playwright"
import { StepError, type StepRef } from "./errors.ts"
import { NetworkTracker } from "./network.ts"
import { SAFE_SELECTOR_RULES, secretsOf } from "./secret-state.ts"
import { type Ctx, firstLine, MIN_TIMEOUT_MS, type RunOptions } from "./run/context.ts"
import { applyHide, hideCss } from "./run/interrupts.ts"
import {
  followSecretFields,
  followSecretText,
  pathOnly,
  scrubError,
  scrubSecrets,
  TEXT_SCAN_MS,
} from "./run/secrets.ts"
import { expandSetup, openingGoto, runSetupEntry } from "./run/setup.ts"
import { perform } from "./run/actions.ts"
import { runOne } from "./run/step.ts"
import { now } from "./clock.ts"

// Runs one scene's scenario against a live page (docs/OBJECT-MODEL.md §2–2b): setup (presets
// expanded, session presets skipped when the page already has their state), then the steps.

/** Hide rules already reported as skipped, per context (one warning each). */
const warnedHideOf = new WeakMap<object, Set<string>>()

/** Runs a scenario. Throws a `StepError` naming the failing step. */
export async function runScenario(
  page: Page,
  scenario: Scenario,
  project: ProjectConfig,
  options: RunOptions = {},
): Promise<void> {
  // Static config errors (unknown preset, unknown app) fail BEFORE anything runs or is attached to
  // the page.
  const unknown = unknownApps(scenario, project)
  if (unknown.length > 0) {
    throw new StepError(
      { phase: "setup", index: 0, action: "setup" },
      "invalid-setup",
      unknown.join("; "),
    )
  }
  // The scene's start app: what its steps mean when they name no app.
  const start = startAppOf(scenario, project).name
  const setup = expandSetup(
    scenario.setup ?? [],
    project,
    options.skipSessionPresets ?? [],
    options.sessionLandings ?? {},
    start,
  )
  const settleMs = scenario.overrides?.pacing?.settleMs ?? project.defaults.pacing.settleMs
  const network = new NetworkTracker(page)
  // Tabs and popups opened by the page being driven: followed after the step that opened them.
  const opened: Page[] = []
  // Every page seen keeps its network tracker (created when it opens, so its load requests count)
  // and its popup listener (a page the opener opens while a popup is driven is still seen).
  const trackers = new Map<Page, NetworkTracker>([[page, network]])
  const watched = new Set<Page>()
  const watch = (p: Page) => {
    if (watched.has(p)) return
    watched.add(p)
    p.on("popup", onPopup)
  }
  const trackerOf = (p: Page): NetworkTracker => {
    let tracker = trackers.get(p)
    if (tracker === undefined) {
      tracker = new NetworkTracker(p)
      trackers.set(p, tracker)
    }
    return tracker
  }
  const onPopup = (popup: Page) => {
    opened.push(popup)
    trackerOf(popup)
    watch(popup)
  }
  // Every main-frame navigation is reported (goto, redirects, links clicked…), attributed to the
  // step running at that moment.
  let current: StepRef | undefined
  let listenerError: StepError | undefined
  // Per browser context, not per run (SECRETS-DESIGN §3 A5): a later run on the same page still
  // knows the values and the fields they were written to (grounding runs one step at a time).
  const secrets = secretsOf(page.context())
  const secretValues = secrets.values
  for (const v of options.knownSecretValues ?? []) if (v.trim() !== "") secretValues.add(v)
  const onNavigated = (frame: Frame) => {
    if (frame === ctx.page.mainFrame() && current !== undefined) {
      try {
        // Only the origin and path are reported: a query string or hash can carry a typed secret or a
        // token in any encoding (a GET form, a `?next=` redirect…). Not recording them removes the
        // whole class; the path is scrubbed too.
        options.onEvent?.({
          kind: "navigate",
          step: current,
          url: scrubSecrets(pathOnly(frame.url()), secretValues),
        })
      } catch (error) {
        // Thrown inside Playwright's event dispatch: keep it and fail the step afterwards.
        listenerError ??= new StepError(current, "action-failed", firstLine(error), {
          cause: error,
        })
      }
    }
  }
  // Navigation reports come from the driven page only.
  const attach = (p: Page) => {
    p.on("framenavigated", onNavigated)
    watch(p)
  }
  const detach = (p: Page) => void p.off("framenavigated", onNavigated)
  attach(page)
  const hide = hideCss(project.hide)
  const ctx: Ctx = {
    page,
    openers: [],
    opened,
    attach,
    detach,
    trackerOf,
    cursors: new Map(),
    interrupts: project.interrupts,
    perform: (action, step) => perform(ctx, action, step),
    hideCss: hide.css,
    interruptsDone: new WeakMap(),
    inInterrupt: false,
    handingOver: false,
    apps: project.apps,
    app: start,
    startApp: start,
    settleMs,
    options,
    network,
    setCurrent: (step) => (current = step),
    secretValues,
    secretFields: [],
    secretFieldCount: 0,
    pageShownAt: now(),
    switching: false,
    stuckReads: new WeakMap(),
    fieldsInflight: undefined,
    secretWritten: secrets.written,
    secretText: {
      shown: new Map(),
      next: 0,
      lastScan: now(),
      runStart: now(),
      values: 0,
      inflight: undefined,
    },
    clearListenerError: () => (listenerError = undefined),
    throwListenerError: () => {
      const error = listenerError
      listenerError = undefined
      if (error !== undefined) throw error
    },
    cursor: undefined,
    pacing: {
      cursor: scenario.overrides?.pacing?.cursor ?? project.defaults.pacing.cursor,
      typing: scenario.overrides?.pacing?.typing ?? project.defaults.pacing.typing,
    },
    timeoutMs: Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? 5000),
    navigationTimeoutMs: Math.max(MIN_TIMEOUT_MS, options.navigationTimeoutMs ?? 30_000),
  }
  // Hide rules the A8 grammar refuses are skipped (a hide rule is live CSS for the whole page: it
  // could test a value a later run knows), reported once per context.
  const warned = warnedHideOf.get(page.context()) ?? new Set<string>()
  warnedHideOf.set(page.context(), warned)
  for (const s of hide.skipped) {
    if (warned.has(s)) continue
    warned.add(s)
    options.onEvent?.({
      kind: "warning",
      message: `hide rule "${s}" is skipped: only simple CSS selectors (${SAFE_SELECTOR_RULES})`,
    })
  }

  // A scene's `teardown` and `ensure` (from before they were removed, OBJECT-MODEL §0.4) never run:
  // a demo's actions stay in the app.
  for (const part of ignoredParts(scenario, project)) {
    options.onEvent?.({
      kind: "warning",
      message: `${part} is skipped: Kiframe no longer cleans up after a demo (its actions stay in the app)`,
    })
  }
  await applyHide(ctx, page)
  // While recording, secrets shown as text are looked for between steps and during them.
  const scan =
    options.recording === true
      ? setInterval(() => {
          if (current === undefined) return
          // Never mid-switch (a scan of the next page would end the regions of the one still filmed).
          if (ctx.switching) return
          followSecretText(ctx, current).catch(() => undefined)
          // Fields too, between step boundaries (a move's hull spans one tick, not a whole step);
          // never piled up.
          if (ctx.fieldsInflight === undefined) {
            followSecretFields(ctx, current).catch(() => undefined)
          }
        }, TEXT_SCAN_MS)
      : undefined
  try {
    let failure: Error | undefined
    try {
      // A fresh browser is blank: a scene that doesn't go to a page first opens on its start app.
      const open =
        options.fresh === true ? openingGoto(setup, scenario.steps, project, start) : undefined
      if (open !== undefined) {
        await runOne(ctx, open, { phase: "setup", index: 0, action: "open app" }, start)
      }
      for (const entry of setup) await runSetupEntry(ctx, entry)
      for (const [index, step] of scenario.steps.entries()) {
        await runOne(
          ctx,
          step,
          { phase: "steps", index, stepId: step.id, action: step.action },
          ctx.startApp,
        )
      }
    } catch (error) {
      // The step's own error is the one reported: never a pending listener error from the same step.
      ctx.clearListenerError()
      failure =
        error instanceof StepError || current === undefined
          ? (error as Error)
          : new StepError(current, "action-failed", firstLine(error), { cause: error })
    }
    let thrown = failure ?? listenerError
    // Stopped: a stop, whatever failed with it (a dialog it closed). A stop landing once every step
    // is done stops nothing (there's nothing after them): the run is complete.
    if (
      thrown !== undefined &&
      options.signal?.aborted === true &&
      !(thrown instanceof StepError && thrown.reason === "stopped")
    ) {
      const at =
        thrown instanceof StepError
          ? thrown.step
          : (current ?? { phase: "steps" as const, index: 0, action: "stop" })
      thrown = new StepError(at, "stopped", "the run was stopped", { cause: thrown })
    }
    // Errors leave the runner scrubbed of every secret value (a Playwright message can quote a URL
    // or a value that carries one).
    if (thrown !== undefined) throw scrubError(thrown, secretValues)
  } finally {
    clearInterval(scan)
    // A scan still running reports before the run ends (the recorder writes right after).
    await ctx.secretText.inflight?.catch(() => undefined)
    // And a field read (T5).
    await ctx.fieldsInflight?.catch(() => undefined)
    for (const tracker of trackers.values()) tracker.dispose()
    for (const p of watched) p.off("popup", onPopup)
    ctx.detach(ctx.page)
  }
}

// The runner's public API (the modules in run/ are internal).
export type { RunnerEvent, RunOptions } from "./run/context.ts"
export { firstLine } from "./run/context.ts"
export { urlMatches } from "./run/conditions.ts"
export { pathOnly, scrubSecrets, secretMatcher, secretScrubber } from "./run/secrets.ts"
export type { HandoverRequest } from "./run/handover.ts"
export type { SessionLanding } from "./run/context.ts"
export { checksSignedIn, sessionChecks } from "./run/setup.ts"

/** The parts of a scene that never run any more: its `teardown`, its `ensure`s and its presets'. */
function ignoredParts(scenario: Scenario, project: ProjectConfig): string[] {
  const parts: string[] = []
  if ((scenario.teardown ?? []).length > 0) parts.push("the scene's teardown")
  if ((scenario.setup ?? []).some((item) => "ensure" in item)) parts.push("the scene's ensure")
  for (const name of presetRefs(scenario)) {
    const preset = Object.hasOwn(project.presets, name) ? project.presets[name] : undefined
    if (preset?.steps.some((s) => "ensure" in s) === true) parts.push(`preset "${name}"'s ensure`)
  }
  return [...new Set(parts)]
}
