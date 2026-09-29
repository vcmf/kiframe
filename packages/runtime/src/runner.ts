import type { ProjectConfig, Scenario } from "@kiframe/schema"
import type { Frame, Page } from "playwright"
import { StepError, type StepRef } from "./errors.ts"
import { NetworkTracker } from "./network.ts"
import { SAFE_SELECTOR_RULES, secretsOf } from "./secret-state.ts"
import { type Ctx, firstLine, MIN_TIMEOUT_MS, type RunOptions } from "./run/context.ts"
import { applyHide, hideCss } from "./run/interrupts.ts"
import { switchPage } from "./run/pages.ts"
import {
  followSecretFields,
  followSecretText,
  pathOnly,
  scrubError,
  scrubSecrets,
  TEXT_SCAN_MS,
} from "./run/secrets.ts"
import { expandSetup, runSetupEntry } from "./run/setup.ts"
import { perform } from "./run/actions.ts"
import { runOne } from "./run/step.ts"

// Runs one scene's scenario against a live page (docs/OBJECT-MODEL.md §2–2b): setup (presets
// expanded, session presets skipped when the page already has their state, `ensure`), steps,
// teardown.

/** Hide rules already reported as skipped, per context (one warning each). */
const warnedHideOf = new WeakMap<object, Set<string>>()

/**
 * Runs a scenario. Throws a `StepError` naming the failing step. Teardown always runs, best effort:
 * every teardown step is attempted even if some fail. The error thrown is the first step failure,
 * else the first teardown failure; every other teardown failure is reported as a `teardown_failed`
 * event.
 */
export async function runScenario(
  page: Page,
  scenario: Scenario,
  project: ProjectConfig,
  options: RunOptions = {},
): Promise<void> {
  // Static config errors (unknown preset) fail BEFORE anything runs or is
  // attached to the page, and don't trigger teardown: nothing was created, and teardown could delete
  // pre-existing data.
  const setup = expandSetup(
    scenario.setup ?? [],
    project,
    options.skipSessionPresets ?? [],
    options.sessionLandings ?? {},
  )
  const base = new URL(project.target.url)
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
    base,
    settleMs,
    options,
    network,
    setCurrent: (step) => (current = step),
    secretValues,
    secretFields: [],
    pageShownAt: Date.now(),
    switching: false,
    fieldsInflight: undefined,
    secretWritten: secrets.written,
    secretText: {
      shown: new Map(),
      next: 0,
      lastScan: Date.now(),
      runStart: Date.now(),
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

  await applyHide(ctx, page)
  // While recording, secrets shown as text are looked for between steps and during them.
  const scan =
    options.recording === true
      ? setInterval(() => {
          if (current === undefined) return
          followSecretText(ctx, current).catch(() => undefined)
          // Fields too, between step boundaries (a move's hull spans one tick, not a whole step);
          // never mid-switch, and never piled up.
          if (!ctx.switching && ctx.fieldsInflight === undefined) {
            followSecretFields(ctx, current).catch(() => undefined)
          }
        }, TEXT_SCAN_MS)
      : undefined
  try {
    let failure: Error | undefined
    try {
      for (const [position, entry] of setup.entries()) {
        await runSetupEntry(ctx, scenario, setup, position, entry)
      }
      for (const [index, step] of scenario.steps.entries()) {
        await runOne(ctx, step, { phase: "steps", index, stepId: step.id, action: step.action })
      }
    } catch (error) {
      // The step's own error is the one reported: don't let a pending listener error from the same
      // step resurface later and cut teardown short.
      ctx.clearListenerError()
      failure =
        error instanceof StepError || current === undefined
          ? (error as Error)
          : new StepError(current, "action-failed", firstLine(error), { cause: error })
    }
    // Teardown is best effort: every step runs (cleanup must go as far as it can), each failure is
    // reported, and the first one is thrown if nothing failed before. Not after an `ensure`
    // failure: no scene step ran, so what the teardown would delete wasn't created by this run.
    const ensureFailed = failure instanceof StepError && failure.step.action === "ensure"
    // The teardown cleans the app where the scene started, not a tab or popup it followed, and
    // never follows a page the scene opened late.
    ctx.opened.length = 0
    let returnFailure: StepError | undefined
    const root = ctx.openers[0]
    if (
      !ensureFailed &&
      root !== undefined &&
      !root.isClosed() &&
      (scenario.teardown ?? []).length > 0
    ) {
      const ref: StepRef = { phase: "teardown", index: 0, action: "return to the start page" }
      ctx.openers.length = 0
      try {
        await switchPage(ctx, root, ref)
      } catch (error) {
        // Best effort like the teardown itself, but never silent (the capture may be off).
        const stepError =
          error instanceof StepError
            ? error
            : new StepError(ref, "action-failed", firstLine(error), { cause: error })
        // The first teardown failure is thrown when nothing failed before; later ones are events.
        if (failure === undefined) returnFailure = stepError
        else {
          try {
            options.onEvent?.({
              kind: "teardown_failed",
              error: scrubError(stepError, secretValues) as StepError,
            })
          } catch {
            // reporting must never stop the cleanup
          }
        }
      }
    }
    let teardownFailure: StepError | undefined = returnFailure
    for (const [index, action] of (ensureFailed ? [] : (scenario.teardown ?? [])).entries()) {
      const ref: StepRef = {
        phase: "teardown",
        index,
        stepId: action.id,
        action: action.action,
        cleanup: true,
      }
      try {
        await runOne(ctx, action, ref)
      } catch (error) {
        const stepError =
          error instanceof StepError
            ? error
            : new StepError(ref, "action-failed", firstLine(error), { cause: error })
        ctx.clearListenerError()
        // The first teardown failure is thrown when nothing failed before: it isn't also reported
        // as an event. Every other one is (it would be lost otherwise).
        if (failure === undefined && teardownFailure === undefined) teardownFailure = stepError
        else {
          try {
            options.onEvent?.({
              kind: "teardown_failed",
              error: scrubError(stepError, secretValues) as StepError,
            })
          } catch {
            // reporting must never stop the remaining cleanup
          }
        }
      }
    }
    // Errors leave the runner scrubbed of every secret value (a Playwright message can quote a URL
    // or a value that carries one).
    if (failure !== undefined) throw scrubError(failure, secretValues)
    if (teardownFailure !== undefined) throw scrubError(teardownFailure, secretValues)
    if (listenerError !== undefined) throw scrubError(listenerError, secretValues)
  } finally {
    clearInterval(scan)
    // A scan still running reports before the run ends (the recorder writes right after).
    await ctx.secretText.inflight?.catch(() => undefined)
    for (const tracker of trackers.values()) tracker.dispose()
    for (const p of watched) p.off("popup", onPopup)
    ctx.detach(ctx.page)
  }
}

// The runner's public API (the modules in run/ are internal).
export type { RunnerEvent, RunOptions } from "./run/context.ts"
export { firstLine } from "./run/context.ts"
export { urlMatches } from "./run/conditions.ts"
export { pathOnly, scrubSecrets } from "./run/secrets.ts"
