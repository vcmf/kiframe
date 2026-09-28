import type {
  Action,
  Condition,
  Ensure,
  ProjectConfig,
  Scenario,
  SetupItem,
  Step,
  Target,
} from "@kiframe/schema"
import { isGrounded, secretRefName } from "@kiframe/schema"
import type { ElementHandle, FileChooser, Frame, Locator, Page } from "playwright"
import { StepError, type StepRef } from "./errors.ts"
import {
  clickPoint,
  type Box,
  planPath,
  seededRandom,
  typingDelays,
  type CursorPacing,
  type Point,
  type TypingPacing,
} from "./motion.ts"
import { NetworkTracker } from "./network.ts"
import {
  describeLocator,
  isOnScreen,
  pointProbe,
  type ProbeArgs,
  resolveTarget,
  stripExtras,
  toPlaywright,
  viewportOf,
  visibleOnly,
} from "./targets.ts"

// Runs one scene's scenario against a live page (docs/OBJECT-MODEL.md §2–2b): setup (presets
// expanded, session presets skipped when the page already has their state, `ensure`), steps,
// teardown.

/** What the runner reports as it goes. The recorder (P0-5) turns these into take events. */
export type RunnerEvent =
  | { kind: "step_start" | "step_end"; step: StepRef }
  | { kind: "navigate"; step: StepRef; url: string }
  /** `secret` is the secret NAME when the value came from the vault; the value is never reported. */
  | { kind: "type"; step: StepRef; secret?: string | undefined; box?: Box | undefined }
  /** Typing into a field starts (the `type` event marks its end). `box`: the field (CSS pixels). */
  | {
      kind: "type_start"
      step: StepRef
      secret?: string | undefined
      /** With a secret: the id of its sensitive region (later `secret_field` events use it). */
      sensitiveId?: string | undefined
      box?: Box | undefined
    }
  /** A click is about to be dispatched at (x, y), on the target's `box` (CSS pixels). */
  | {
      kind: "click"
      step: StepRef
      x: number
      y: number
      box: Box
      button: "left" | "right"
      count: number
    }
  /** Where a field holding a secret is now (`box`), or that it's gone (no `box`). Recording only. */
  | {
      kind: "secret_field"
      step: StepRef
      id: string
      box?: Box | undefined
      /** The CSS viewport the box was measured in (pages can differ: a popup has its own). */
      viewport?: { width: number; height: number } | undefined
    }
  /** A key combination was pressed (`press` action). */
  | { kind: "key"; step: StepRef; keys: string }
  /** The cursor moved or was pressed/released (CSS pixels of the viewport). For the recorder (P0-5). */
  | { kind: "cursor"; step: StepRef; x: number; y: number; pressed: boolean }
  /** A fallback locator was used: the primary one no longer matches (a signal for self-healing). */
  | { kind: "target_fallback"; step: StepRef; fallbackIndex: number }
  /** Teardown failed after a step had already failed: the step's error is the one thrown. */
  | { kind: "teardown_failed"; error: StepError }
  /** A preset's steps all ran: for a session preset, the moment to save the context's state. */
  | { kind: "preset_done"; name: string; session: boolean }

export interface RunOptions {
  /** Resolves a secret NAME to its value, at the moment of the fill. Throw if unavailable. */
  resolveSecret?: (name: string) => string | Promise<string>
  /** Resolves an `upload` step's project asset (`<sha256>.<ext>`) to a file path. */
  resolveAsset?: (file: string) => string | Promise<string>
  /**
   * The runner now drives another page: a tab or popup the last step opened, or back to its opener
   * when that one closed. Awaited before the next step (the recorder moves its screencast here).
   */
  onPageSwitch?: (page: Page) => void | Promise<void>
  /** Called for every runner event. Must not throw. */
  onEvent?: (event: RunnerEvent) => void
  /** Risky steps (delete, send, pay…) run only if this returns true (approval / sandbox, §7.2). */
  approveRisky?: (step: StepRef) => boolean | Promise<boolean>
  /** Per-step timeout for finding targets and waiting on conditions. Default 5000 ms. */
  timeoutMs?: number
  /** Timeout of a `goto` navigation (page load). Default 30000 ms. */
  navigationTimeoutMs?: number
  /** Set by the recorder: measure targets and fields for the take (extra page round trips). */
  recording?: boolean
  /**
   * Session presets whose state the page already has (its context was created from the storage
   * state saved after they ran, once per batch): they're skipped. See the `preset_done` event.
   */
  skipSessionPresets?: readonly string[]
}

type AnyAction = Action | Step

/** Playwright treats a timeout of 0 as "wait forever": never pass it through. */
const MIN_TIMEOUT_MS = 1

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
  const setup = expandSetup(scenario.setup ?? [], project, options.skipSessionPresets ?? [])
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
  const secretValues = new Set<string>()
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
  const ctx: Ctx = {
    page,
    openers: [],
    opened,
    attach,
    detach,
    trackerOf,
    cursors: new Map(),
    base,
    settleMs,
    options,
    network,
    setCurrent: (step) => (current = step),
    secretValues,
    secretFields: [],
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
        if (failure === undefined && returnFailure === undefined) returnFailure = stepError
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
      const ref: StepRef = { phase: "teardown", index, stepId: action.id, action: action.action }
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
    for (const tracker of trackers.values()) tracker.dispose()
    for (const p of watched) p.off("popup", onPopup)
    ctx.detach(ctx.page)
  }
}

interface Ctx {
  page: Page
  base: URL
  settleMs: number
  timeoutMs: number
  navigationTimeoutMs: number
  network: NetworkTracker
  /** Pages this run came from (the opener of each tab or popup followed), most recent last. */
  openers: Page[]
  /** Tabs and popups the driven page opened, not followed yet. */
  opened: Page[]
  /** Moves the run's navigation reports to or from a page. */
  attach: (page: Page) => void
  detach: (page: Page) => void
  /** The network tracker of a page (kept for the whole run). */
  trackerOf: (page: Page) => NetworkTracker
  /** Where the cursor was on each page the run left. */
  cursors: Map<Page, Point>
  setCurrent: (step: StepRef | undefined) => void
  /** Secret values resolved during this run (memory only): anything reported is scrubbed of them. */
  secretValues: Set<string>
  /** Fields a secret was typed into (recording): re-measured after every step. */
  secretFields: {
    id: string
    locator: Locator
    page: Page
    last?: string
    /** The last real box (kept while the run is on another page). */
    lastBox?: Box
    /** Blur ended only because the run left its page (not because the field went away). */
    away?: boolean
  }[]
  /** Rethrows (once) an error raised inside a Playwright event listener during this step. */
  throwListenerError: () => void
  clearListenerError: () => void
  /** Where the cursor is (CSS pixels); undefined until the first movement. */
  cursor: Point | undefined
  pacing: { cursor: CursorPacing; typing: TypingPacing }
  options: RunOptions
}

/** A setup item once presets are inlined: an action, an `ensure`, or the end of a preset. */
type PresetOrigin = { name: string; session: boolean }
type SetupEntry =
  | { kind: "action"; index: number; action: Action; preset?: PresetOrigin }
  | { kind: "ensure"; index: number; ensure: Ensure["ensure"] }
  | ({ kind: "preset_done" } & PresetOrigin)

/**
 * Inlines presets into setup, and drops session presets the page already has (`skipSessionPresets`).
 * Error indexes are post-expansion, like the `setup[i]` of runtime errors.
 */
function expandSetup(
  items: readonly SetupItem[],
  project: ProjectConfig,
  skip: readonly string[],
): SetupEntry[] {
  const out: SetupEntry[] = []
  // Setup indexes count actions and ensures only (`preset_done` is a marker, not a step).
  let n = 0
  const invalid = (detail: string) =>
    new StepError({ phase: "setup", index: n, action: "setup" }, "invalid-setup", detail)
  for (const item of items) {
    if ("preset" in item) {
      const preset = Object.hasOwn(project.presets, item.preset)
        ? project.presets[item.preset]
        : undefined
      if (preset === undefined) throw invalid(`unknown preset "${item.preset}"`)
      if (preset.session && skip.includes(item.preset)) continue
      const from = { name: item.preset, session: preset.session }
      for (const s of preset.steps) {
        out.push(
          "ensure" in s
            ? { kind: "ensure", index: n++, ensure: s.ensure }
            : { kind: "action", index: n++, action: s, preset: from },
        )
      }
      out.push({ kind: "preset_done", ...from })
    } else if ("ensure" in item) {
      out.push({ kind: "ensure", index: n++, ensure: item.ensure })
    } else {
      out.push({ kind: "action", index: n++, action: item })
    }
  }
  return out
}

async function runSetupEntry(
  ctx: Ctx,
  scenario: Scenario,
  setup: readonly SetupEntry[],
  position: number,
  entry: SetupEntry,
): Promise<void> {
  if (entry.kind === "preset_done") {
    ctx.options.onEvent?.({ kind: "preset_done", name: entry.name, session: entry.session })
    return
  }
  if (entry.kind === "action") {
    const { action } = entry
    await runOne(ctx, action, {
      phase: "setup",
      index: entry.index,
      stepId: action.id,
      action: action.action,
    })
    return
  }
  await ensure(ctx, scenario, setup.slice(0, position), entry.index, entry.ensure)
}

/** After the page settles, how long an `absent` check waits for something that renders late. */
const ABSENT_GRACE_MS = 1000

/**
 * `ensure` (docs/OBJECT-MODEL.md §2): the one declarative idempotency primitive.
 * - `absent`: if the element is there, run this scene's teardown, replay the setup that led here
 *   (actions only: no session preset, no other `ensure`), and check again.
 * - `present`: nothing can create it declaratively: fail with a message saying so.
 * "There" = a visible match: waited for up to the step timeout (`present`), or for a short grace
 * after the page settles (`absent`: lists that load late must not look empty).
 * The cleanup runs inside this step: its steps are reported as `ensure: <action>` of this setup
 * index, and any failure is this step's (`ensure-failed`), never a teardown failure.
 */
async function ensure(
  ctx: Ctx,
  scenario: Scenario,
  before: readonly SetupEntry[],
  index: number,
  condition: Ensure["ensure"],
): Promise<void> {
  const ref: StepRef = { phase: "setup", index, action: "ensure" }
  ctx.setCurrent(ref)
  // Its own ref: a page failing to load here is that setup's failure, not an `ensure` one (which
  // would skip the teardown).
  await syncPage(ctx, { phase: "setup", index, action: "follow page" })
  ctx.options.onEvent?.({ kind: "step_start", step: ref })
  const locator = "absent" in condition ? condition.absent : condition.present
  const what = describeLocator(locator)
  // On a blank page everything is absent (a skipped session preset left nothing loaded).
  if (ctx.page.url() === "about:blank") {
    throw new StepError(ref, "ensure-failed", "`ensure` needs a page: add a `goto` before it")
  }
  const appears = async (timeout: number) => {
    try {
      await waitForCondition(ctx, { visible: locator }, timeout, ref, "condition-timeout")
      return true
    } catch (error) {
      if (error instanceof StepError && error.reason === "condition-timeout") return false
      throw error
    }
  }
  const leftovers = async () => {
    await guard(ref, () => settle(ctx, false))
    return appears(ABSENT_GRACE_MS)
  }
  if ("present" in condition) {
    if (!(await appears(ctx.timeoutMs))) {
      throw new StepError(
        ref,
        "ensure-failed",
        `${what} must be present before filming: create it earlier in the setup or in a preset`,
      )
    }
  } else if (await leftovers()) {
    // Leftovers from an earlier run: the scene's own teardown removes what the scene creates.
    const teardown = scenario.teardown ?? []
    if (teardown.length === 0) {
      throw new StepError(
        ref,
        "ensure-failed",
        `${what} must be absent before filming, and the scene has no teardown to remove it`,
      )
    }
    // Back to where the check happens: the setup before it, session presets' navigations included
    // (their state is kept, but the page they led to may be the only `goto`).
    const replay = before.flatMap((e) =>
      e.kind === "action" && (e.preset?.session !== true || e.action.action === "goto")
        ? [e.action]
        : [],
    )
    const stages: [string, readonly Action[]][] = [
      [`removing ${what} (teardown)`, teardown],
      ["returning to the setup page", replay],
    ]
    for (const [stage, actions] of stages) {
      for (const [i, action] of actions.entries()) {
        try {
          await runOne(ctx, action, {
            phase: "setup",
            index,
            stepId: action.id,
            action: `ensure: ${action.action}`,
          })
        } catch (error) {
          ctx.clearListenerError()
          // The cause's own reason is kept (a risky step waiting for approval must stay that).
          const reason = error instanceof StepError ? error.reason : "ensure-failed"
          const detail = error instanceof StepError ? error.detail : firstLine(error)
          throw new StepError(
            ref,
            reason,
            `${stage}, step ${i + 1} (${action.action}): ${detail}`,
            {
              cause: error,
            },
          )
        }
      }
    }
    ctx.setCurrent(ref)
    if (await leftovers()) {
      throw new StepError(ref, "ensure-failed", `${what} is still present after the teardown ran`)
    }
  }
  ctx.throwListenerError()
  ctx.options.onEvent?.({ kind: "step_end", step: ref })
}

/** Runs one action. Every failure, including from callbacks, is a StepError naming this step. */
async function runOne(ctx: Ctx, action: AnyAction, step: StepRef): Promise<void> {
  ctx.setCurrent(step)
  // Before step_start: the step's storyboard shot (taken at step_start) is of the page it acts on.
  await syncPage(ctx, step)
  if (action.risky === true) await requireApproval(ctx, step, "risky step needs approval")
  ctx.options.onEvent?.({ kind: "step_start", step })
  await perform(ctx, action, step)
  // Settle after actions that act on the app (not after pauses and checks). The extra `settleMs`
  // pacing is a presentation choice: on camera only. A page the action closed has nothing to settle.
  if (!["pause", "expect", "waitFor"].includes(action.action)) {
    await guard(step, () => settle(ctx, step.phase === "steps"))
  }
  await syncPage(ctx, step)
  if (ctx.options.recording === true) await followSecretFields(ctx, step)
  ctx.throwListenerError()
  ctx.options.onEvent?.({ kind: "step_end", step })
}

/** Drives `next` from now on: listeners, network tracking, the recorder's capture follow it. */
async function switchPage(ctx: Ctx, next: Page, step: StepRef): Promise<void> {
  ctx.detach(ctx.page)
  // Headed and CDP runs: the driven page is the visible tab (a background tab is throttled).
  await next.bringToFront().catch(() => undefined)
  // The real mouse is per page: each page keeps where the cursor was on it.
  if (ctx.cursor !== undefined) ctx.cursors.set(ctx.page, ctx.cursor)
  ctx.page = next
  ctx.network = ctx.trackerOf(next)
  ctx.attach(next)
  ctx.cursor = ctx.cursors.get(next)
  // This page's secret fields are measured BEFORE the capture moves here (its first frame is
  // already covered); the other pages' blurs end only AFTER the capture left them.
  if (ctx.options.recording === true) await followSecretFields(ctx, step, "here")
  await guard(step, async () => ctx.options.onPageSwitch?.(next))
  if (ctx.options.recording === true) await followSecretFields(ctx, step, "elsewhere")
  ctx.options.onEvent?.({
    kind: "navigate",
    step,
    url: scrubSecrets(pathOnly(next.url()), ctx.secretValues),
  })
}

/**
 * Brings the driven page in line with the browser, at a step boundary (the one place pages change):
 * 1. the driven page closed (a popup's "Done", an OAuth window): back to the nearest open opener;
 * 2. setup and scene steps only: the LAST page opened, if it's still open once loaded, is driven
 *    from now on (and settled). If it closed already, the run stays where it is: an earlier tab is
 *    never picked instead. The teardown never follows new pages (it cleans up where it runs).
 */
async function syncPage(ctx: Ctx, step: StepRef): Promise<void> {
  if (ctx.page.isClosed()) {
    let back = ctx.openers.pop()
    while (back?.isClosed() === true) back = ctx.openers.pop()
    // "Continue in a new window": the page opened a tab and closed itself.
    back ??= ctx.opened.filter((p) => !p.isClosed()).at(-1)
    if (back !== undefined) ctx.opened.splice(0)
    if (back === undefined) {
      throw new StepError(
        step,
        "action-failed",
        "the page was closed and there's no page to return to",
      )
    }
    await switchPage(ctx, back, step)
    // The opener reacts (an OAuth callback loads the app): settled before going on.
    await guard(step, () => settle(ctx, step.phase === "steps"))
  }
  const next = ctx.opened.splice(0).at(-1)
  if (step.phase === "teardown" || next === undefined || next.isClosed()) return
  try {
    await next.waitForLoadState("domcontentloaded", { timeout: ctx.navigationTimeoutMs })
  } catch (error) {
    // Closed itself while loading (an OAuth popup with a session already): stay here.
    if (next.isClosed()) return
    throw new StepError(step, "action-failed", firstLine(error), { cause: error })
  }
  if (next.isClosed()) return
  ctx.openers.push(ctx.page)
  await switchPage(ctx, next, step)
  // Settled like any page an action led to (its data may load after DOMContentLoaded).
  await guard(step, () => settle(ctx, step.phase === "steps"))
}

/**
 * Re-measures every field a secret was typed into and reports when it moved (the blur follows it)
 * or is gone (navigated away, removed: nothing left to blur). Only changes are reported. Bounded,
 * never fails a step.
 */
async function followSecretFields(
  ctx: Ctx,
  step: StepRef,
  which: "all" | "here" | "elsewhere" = "all",
): Promise<void> {
  const fields = ctx.secretFields.filter(
    (f) => which === "all" || (which === "here") === (f.page === ctx.page),
  )
  if (fields.length === 0) return
  // In parallel: every field costs a round trip or two after each step.
  // A field on another page (the run followed a tab or popup) isn't on screen: its blur ends,
  // and comes back if the run returns to that page.
  const measured = await Promise.all(
    fields.map((field) =>
      field.page === ctx.page ? measureField(field.locator) : Promise.resolve(null),
    ),
  )
  const viewport = await viewportOf(ctx.page).catch(() => undefined)
  for (const [i, field] of fields.entries()) {
    let box = measured[i]
    const elsewhere = field.page !== ctx.page
    // Unsure, just back on its page: the last real rect comes back (fails closed). Otherwise an
    // unsure measurement keeps the current rect; only a field known to be gone ends its blur.
    if (box === "unknown" && field.away === true && !elsewhere) box = field.lastBox ?? "unknown"
    if (box === undefined || box === "unknown") continue
    field.away = elsewhere
    if (box !== null) field.lastBox = box
    const key = box === null ? "gone" : `${box.x},${box.y},${box.width},${box.height}`
    if (key === field.last) continue
    field.last = key
    ctx.options.onEvent?.({
      kind: "secret_field",
      step,
      id: field.id,
      box: box ?? undefined,
      viewport,
    })
  }
}

/**
 * Where a secret field is now: its box, null when it's known to be gone (detached or not rendered),
 * "unknown" when measuring failed (timeout, several matches): the blur stays where it was.
 */
async function measureField(locator: Locator): Promise<Box | null | "unknown"> {
  try {
    // count() doesn't wait: a field that's gone (after a login submit) costs one round trip, not
    // boundingBox's attach timeout on every later step.
    if ((await locator.count()) === 0) return null
    return await locator.boundingBox({ timeout: 300 })
  } catch {
    return "unknown"
  }
}

async function requireApproval(ctx: Ctx, step: StepRef, detail: string): Promise<void> {
  const approved = await guard(step, async () => (await ctx.options.approveRisky?.(step)) ?? false)
  if (!approved) throw new StepError(step, "risky-not-approved", detail)
}

/**
 * Obvious risky actions, detected from the clicked element's label even without `risky: true`
 * (docs/OBJECT-MODEL.md §2b). `risky: false` on the step is an explicit opt-out.
 */
const RISKY_LABEL =
  /\b(delete|remove|trash|destroy|erase|drop|revoke|cancel subscription|send|submit payment|pay|purchase|buy|checkout|transfer|invite|publish|deploy)\b/i

/**
 * Runs a pointer action; if it fails on a target that is off screen (entirely outside the viewport,
 * after `find` scrolled it: a collapsed sidebar or drawer), the error says so instead of a bare
 * timeout. Diagnosis only: nothing changes for an action that succeeds.
 */
async function explainOffScreen(
  ctx: Ctx,
  target: Locator,
  step: StepRef,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action()
  } catch (error) {
    // Only Playwright's own timeout on the action: approvals, "nothing was clicked" and every
    // other reason stay as they are.
    if (
      !(error instanceof StepError) ||
      error.reason !== "action-failed" ||
      !/Timeout \d+ms exceeded/.test(error.detail)
    ) {
      throw error
    }
    const box = await target.boundingBox({ timeout: 300 }).catch(() => null)
    const viewport = box === null ? undefined : await viewportOf(ctx.page).catch(() => undefined)
    const outside =
      box !== null &&
      viewport !== undefined &&
      (box.x + box.width <= 0 ||
        box.y + box.height <= 0 ||
        box.x >= viewport.width ||
        box.y >= viewport.height)
    if (!outside) throw error
    throw new StepError(
      step,
      "target-not-found",
      "the target is off screen even after scrolling (inside a collapsed panel or drawer?): open it first, or use another element",
      { cause: error },
    )
  }
}

/** Upper bound of each settle wait: pages with constant activity (animations, polling) never block. */
const SETTLE_MAX_MS = 3000

/**
 * After an action, wait for the app to settle (docs/OBJECT-MODEL.md §2b): no request in flight and
 * no DOM mutation for a short quiet period, then the project's extra `settleMs`. Each wait is
 * bounded and never fails the step.
 */
async function settle(ctx: Ctx, onCamera: boolean): Promise<void> {
  // A page that closed (a popup's "Authorize" closes it after a request) has nothing to settle.
  if (ctx.page.isClosed()) return
  try {
    // Network and DOM are independent: wait for both at once, so the worst case is one cap.
    await Promise.all([ctx.network.waitForIdle(SETTLE_MAX_MS, 200), domQuiet(ctx)])
    if (onCamera && ctx.settleMs > 0) await ctx.page.waitForTimeout(ctx.settleMs)
  } catch (error) {
    if (ctx.page.isClosed()) return
    throw error
  }
}

async function domQuiet(ctx: Ctx): Promise<void> {
  await ctx.page
    .evaluate(
      ({ quiet, max }) =>
        new Promise<void>((resolve) => {
          let timer = setTimeout(done, quiet)
          const bump = () => {
            clearTimeout(timer)
            timer = setTimeout(done, quiet)
          }
          const options = { subtree: true, childList: true, attributes: true, characterData: true }
          const observer = new MutationObserver(bump)
          // MutationObserver doesn't see into shadow roots: observe every open one as well
          // (web-component apps render inside them).
          const observed = new Set<Node>()
          const observe = (root: Node) => {
            if (observed.has(root)) return
            observed.add(root)
            observer.observe(root, options)
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
            for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
              const shadow = (n as Element).shadowRoot
              if (shadow !== null) observe(shadow)
            }
          }
          observe(document)
          const cap = setTimeout(done, max)
          function done() {
            observer.disconnect()
            clearTimeout(timer)
            clearTimeout(cap)
            resolve()
          }
        }),
      { quiet: 150, max: SETTLE_MAX_MS },
    )
    .catch(() => undefined) // the page navigated meanwhile: nothing to observe
}

async function perform(ctx: Ctx, action: AnyAction, step: StepRef): Promise<void> {
  const { page } = ctx
  switch (action.action) {
    case "goto": {
      const url = new URL(action.url, ctx.base)
      // Enforced here too (not only by the schema): a scene never leaves the target app.
      if (url.origin !== ctx.base.origin) {
        throw new StepError(step, "off-origin", `goto would leave the target app (${url.origin})`)
      }
      await guard(step, async () => {
        await page.goto(url.href, { waitUntil: "load", timeout: ctx.navigationTimeoutMs })
        // Input sent before the first rendered frame (e.g. a wheel) is dropped by the browser.
        // Bounded: rAF is paused in background windows (headed, CDP-connected, Electron). If the
        // page redirects itself on load (e.g. to /login), the context is replaced: wait for the
        // new page instead of failing a valid navigation.
        try {
          await page.evaluate(
            () =>
              new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(resolve))
                setTimeout(resolve, 500)
              }),
          )
        } catch {
          await page.waitForLoadState("load", { timeout: ctx.navigationTimeoutMs })
        }
      })
      return
    }
    case "click": {
      const target = await find(ctx, action.target, step)
      await explainOffScreen(ctx, target, step, () => clickAtCursor(ctx, target, step, action))
      return
    }
    case "hover": {
      const target = await find(ctx, action.target, step)
      await explainOffScreen(ctx, target, step, async () => {
        // The cursor's own (real) mouse move ends over the target; without a box, Playwright hovers.
        const at = await moveCursorTo(ctx, target, step)
        // Something on top (a sticky header, a toast) can take the hover: then Playwright hovers,
        // with its own actionability and hit checks.
        const hovered =
          at !== undefined &&
          (await target
            .evaluate((el) => el.matches(":hover"), undefined, { timeout: ctx.timeoutMs })
            .catch(() => false))
        if (!hovered) {
          await guard(step, () => target.hover({ timeout: ctx.timeoutMs }))
          // Playwright hovered the center: the cursor (and its next travel) starts from there.
          const box = await target.boundingBox({ timeout: ctx.timeoutMs }).catch(() => null)
          if (box !== null) {
            ctx.cursor = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
            ctx.options.onEvent?.({ kind: "cursor", step, ...ctx.cursor, pressed: false })
          }
        }
      })
      return
    }
    case "type": {
      const target = await find(ctx, action.target, step)
      const secret = secretRefName(action.value)
      assertSecretOrigin(ctx, secret, step)
      const text = secret === undefined ? action.value : await resolveSecret(ctx, secret, step)
      const sensitiveId =
        secret === undefined ? undefined : `secret:${secret}:${step.phase}:${step.index}`
      // A field holding a secret is followed until the end of the take: its blur rect must move with it.
      if (sensitiveId !== undefined && ctx.options.recording === true) {
        ctx.secretFields.push({ id: sensitiveId, locator: target, page: ctx.page })
      }
      if (step.phase === "steps") await moveCursorTo(ctx, target, step)
      let fieldBox: Box | null = null
      await guard(step, async () => {
        const timeout = ctx.timeoutMs
        // Same semantics on and off camera: the text is added at the end of the field's content,
        // unless `clear` empties the field first.
        if (action.clear === true) await target.fill("", { timeout })
        await target.focus({ timeout })
        // The text goes to the focused element: make sure it's the target, never the field focused
        // before (a secret would land there, on camera).
        const focused = await target.evaluate(
          (el) => {
            // In shadow DOM, document.activeElement is the host: ask the element's own root.
            const root = el.getRootNode()
            const active =
              root instanceof ShadowRoot || root instanceof Document ? root.activeElement : null
            return active !== null && (el === active || el.contains(active))
          },
          undefined,
          { timeout },
        )
        if (!focused) {
          throw new StepError(
            step,
            "action-failed",
            "target can't take keyboard focus (use a locator for the input itself)",
          )
        }
        await target.evaluate(moveCaretToEnd, undefined, { timeout })
        // The field as it is now (focus and clear can scroll or re-lay out): what the blur must cover.
        if (ctx.options.recording === true) {
          fieldBox = await target
            .boundingBox({ timeout: Math.min(ctx.timeoutMs, 500) })
            .catch(() => null)
        }
        ctx.options.onEvent?.({
          kind: "type_start",
          step,
          secret,
          sensitiveId,
          box: fieldBox ?? undefined,
        })
        // Checked again right before the text is sent: the page may have navigated while the
        // secret was being resolved.
        assertSecretOrigin(ctx, secret, step)
        if (action.instant === true || secret !== undefined) {
          await page.keyboard.insertText(text)
        } else {
          // The keyboard, not locator.pressSequentially: it would re-focus the field and reset the
          // caret to the start when the window doesn't have OS focus (headed, Electron).
          const pacing = step.phase === "steps" ? ctx.pacing.typing : "instant"
          if (pacing === "instant") {
            await page.keyboard.type(text)
          } else {
            const delays = typingDelays(text, pacing, seededRandom(`${seedOf(step)}:typing`))
            // delays[i] is the pause BEFORE character i (word and sentence boundaries).
            for (const [i, char] of [...text].entries()) {
              const delay = delays[i] ?? 0
              if (delay > 0) await sleep(delay)
              await page.keyboard.type(char)
            }
          }
        }
      })
      // End of typing (before the submit, which may navigate or re-lay out the page).
      ctx.options.onEvent?.({ kind: "type", step, secret, box: fieldBox ?? undefined })
      if (action.submit === true) {
        await guard(step, () => target.press("Enter", { timeout: ctx.timeoutMs }))
        ctx.options.onEvent?.({ kind: "key", step, keys: "Enter" })
      }
      return
    }
    case "press":
      await guard(step, () => page.keyboard.press(toPlaywrightKeys(action.keys)))
      ctx.options.onEvent?.({ kind: "key", step, keys: action.keys })
      return
    case "scroll":
      await scroll(ctx, action, step)
      return
    case "waitFor":
      await waitForCondition(
        ctx,
        action.until,
        timeoutOf(ctx, action.timeout),
        step,
        "condition-timeout",
      )
      return
    case "expect":
      await waitForCondition(
        ctx,
        action.that,
        timeoutOf(ctx, action.timeout),
        step,
        "expectation-failed",
      )
      return
    case "pause":
      await guard(step, () => page.waitForTimeout(action.ms))
      return
    case "select": {
      const target = await find(ctx, action.target, step)
      // The cursor goes to it (on camera); the native dropdown isn't in the screencast anyway.
      await explainOffScreen(ctx, target, step, async () => {
        const at = await moveCursorTo(ctx, target, step)
        await reportPress(ctx, step, target, at)
        // Playwright's own: a string matches an option's value or its label.
        await guard(step, () => target.selectOption(action.option, { timeout: ctx.timeoutMs }))
      })
      return
    }
    case "drag":
      await drag(ctx, action, step)
      return
    case "upload":
      await upload(ctx, action, step)
      return
    default: {
      // A new action kind must be implemented here: never silently skipped.
      const unknown: never = action
      throw new StepError(step, "action-failed", `unsupported action ${JSON.stringify(unknown)}`)
    }
  }
}

/** A press (click event) for the recorder: ripple and camera framing. Recording only. */
async function reportPress(
  ctx: Ctx,
  step: StepRef,
  target: Locator,
  at: Point | undefined,
  /** Also framed (a drag's drop area): the rect covers both. */
  also?: Box,
): Promise<void> {
  if (ctx.options.onEvent === undefined || ctx.options.recording !== true) return
  const own = await target.boundingBox({ timeout: 300 }).catch(() => null)
  if (own === null) return
  const box = also === undefined ? own : unionBox(own, also)
  const where = at ?? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  ctx.options.onEvent({ kind: "click", step, ...where, box, button: "left", count: 1 })
}

/** `n` evenly spaced samples from `from` (excluded) to `to` (included), 16 ms apart. */
function evenPath(from: Point, to: Point, n: number): { t: number; x: number; y: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const u = (i + 1) / n
    return { t: (i + 1) * 16, x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u }
  })
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

/**
 * Drag the target to another element or by an offset. On camera: the human cursor path with the
 * button held (pressed cursor samples). Off camera: Playwright's own `dragTo`, or a plain offset.
 */
async function drag(
  ctx: Ctx,
  action: Extract<AnyAction, { action: "drag" }>,
  step: StepRef,
): Promise<void> {
  const source = await find(ctx, action.target, step)
  const dest = "dx" in action.to ? undefined : await find(ctx, action.to, step)
  // Playwright's own drag (its actionability and hit checks), several moves: pointer drag
  // libraries ignore the move that starts a drag. The cursor ends where the drop was.
  const platformDrag = async (to: Locator) => {
    await guard(step, () => source.dragTo(to, { timeout: ctx.timeoutMs, steps: 5 }))
    // Measured after: dragTo may have scrolled the target into view.
    const box = await to.boundingBox({ timeout: 300 }).catch(() => null)
    if (box !== null) ctx.cursor = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  // Filmed (even with instant pacing: the cursor and the press are still reported), or not.
  const onCamera = step.phase === "steps"
  if (!onCamera && dest !== undefined) return platformDrag(dest)
  // Pressed where the cursor is, on the source: never elsewhere (scrolling to the drop target can
  // push the source off screen: then the two don't fit together, and the step says so).
  const start = await moveCursorTo(ctx, source, step)
  if (start === undefined) {
    throw new StepError(
      step,
      "target-not-found",
      "the element to drag isn't on screen (with its drop target): make the view show both",
    )
  }
  // Something on top of the source at that point (a sticky toolbar, a toast) would get the press:
  // then Playwright drags, with its own hit checks (the cursor path isn't filmed for this one).
  const onSource = await source
    .evaluate((el) => el.matches(":hover"), undefined, { timeout: ctx.timeoutMs })
    .catch(() => false)
  if (!onSource) {
    if (dest !== undefined) return platformDrag(dest)
    throw new StepError(
      step,
      "action-failed",
      "the element to drag is covered where it would be pressed",
    )
  }
  const viewport = await guard(step, () => viewportOf(ctx.page))
  const dropPoint = async (): Promise<Point> => {
    if (dest === undefined) {
      const offset = action.to as { dx: number; dy: number }
      const p = { x: start.x + offset.dx, y: start.y + offset.dy }
      // Never a shorter drag than asked (a slider would stop at the wrong value): say so instead.
      if (p.x < 0 || p.y < 0 || p.x > viewport.width - 1 || p.y > viewport.height - 1) {
        throw new StepError(
          step,
          "action-failed",
          `the drag by (${offset.dx}, ${offset.dy}) would leave the view: scroll first, or drag less`,
        )
      }
      return p
    }
    const box = await guard(step, () => dest.boundingBox({ timeout: ctx.timeoutMs }))
    const visible = visiblePart(box, viewport)
    if (visible === undefined) {
      throw new StepError(step, "target-not-found", "the drop target isn't on screen")
    }
    return clickPoint(visible, seededRandom(`${seedOf(step)}:drop`))
  }
  const planned = await dropPoint()
  // Framed as source + drop area: the camera must show where the card goes.
  await reportPress(ctx, step, source, start, {
    x: planned.x - 20,
    y: planned.y - 20,
    width: 40,
    height: 40,
  })
  const emit = (p: Point, pressed: boolean) =>
    ctx.options.onEvent?.({ kind: "cursor", step, ...p, pressed })
  await guard(step, () => ctx.page.mouse.down())
  emit(start, true)
  let released = false
  try {
    // A first move past the libraries' activation thresholds (react-beautiful-dnd 5 px, dnd-kit
    // often 8 px), toward the drop: the drag starts on it and may re-lay out (the source leaves the
    // list, a placeholder appears). The drop point is measured after that.
    const dist = Math.max(1, Math.hypot(planned.x - start.x, planned.y - start.y))
    const step12 = Math.min(12, dist)
    const nudge = {
      x: Math.min(
        viewport.width - 1,
        Math.max(0, start.x + ((planned.x - start.x) / dist) * step12),
      ),
      y: Math.min(
        viewport.height - 1,
        Math.max(0, start.y + ((planned.y - start.y) / dist) * step12),
      ),
    }
    await guard(step, () => ctx.page.mouse.move(nudge.x, nudge.y))
    emit(nudge, true)
    const to = dest === undefined ? planned : await dropPoint()
    const path = planPath(nudge, to, {
      // Off camera (an offset drag in setup / teardown): instant, like any off-camera move.
      pacing: onCamera ? ctx.pacing.cursor : "instant",
      targetWidth: 40,
      viewport,
      random: seededRandom(`${seedOf(step)}:drag`),
      // Never past the drop point with the button held (another column, a slider value).
      overshoot: false,
    })
    // Always several moves (instant pacing plans one).
    await travel(ctx, step, path.length >= 5 ? path : evenPath(nudge, to, 5), true)
    await guard(step, () => ctx.page.mouse.up())
    released = true
    emit(to, false)
  } finally {
    // Never leave the button held (the next steps would drag too); Escape first cancels the drag
    // in most libraries, so a failed drag doesn't drop where the cursor happens to be.
    if (!released) {
      await ctx.page.keyboard.press("Escape").catch(() => undefined)
      await ctx.page.mouse.up().catch(() => undefined)
    }
  }
}

/** The target, if it resolves to exactly one hidden `<input type=file>` (primary locator only). */
async function hiddenFileInput(ctx: Ctx, target: Target): Promise<Locator | undefined> {
  if (!isGrounded(target)) return undefined
  const candidates = toPlaywright(ctx.page, stripExtras(target)).and(
    ctx.page.locator("input[type=file]"),
  )
  const count = await candidates.count().catch(() => 0)
  if (count !== 1) return undefined
  const visible = await candidates.isVisible().catch(() => true)
  return visible ? undefined : candidates
}

/**
 * Upload a project asset: straight into the target if it's a file input, else through the file
 * chooser that clicking the target opens (a styled button or label). The OS dialog never shows.
 */
async function upload(
  ctx: Ctx,
  action: Extract<AnyAction, { action: "upload" }>,
  step: StepRef,
): Promise<void> {
  const resolver = ctx.options.resolveAsset
  if (resolver === undefined) {
    throw new StepError(
      step,
      "action-failed",
      "an upload needs the project's assets (no asset resolver given)",
    )
  }
  const file = await guard(step, async () => resolver(action.file))
  // A file input is often hidden behind a styled button: `setInputFiles` works on it anyway.
  const hidden = await hiddenFileInput(ctx, action.target)
  if (hidden !== undefined) {
    await guard(step, () => hidden.setInputFiles(file, { timeout: ctx.timeoutMs }))
    return
  }
  let target: Locator
  try {
    target = await find(ctx, action.target, step)
  } catch (error) {
    // Nothing visible: the hidden input may have rendered late (checked once more now).
    const late = await hiddenFileInput(ctx, action.target)
    if (late === undefined) throw error
    await guard(step, () => late.setInputFiles(file, { timeout: ctx.timeoutMs }))
    return
  }
  const isFileInput = await guard(step, () =>
    target.evaluate((el) => el instanceof HTMLInputElement && el.type === "file", undefined, {
      timeout: ctx.timeoutMs,
    }),
  )
  if (isFileInput) {
    const at = await moveCursorTo(ctx, target, step)
    await reportPress(ctx, step, target, at)
    await guard(step, () => target.setInputFiles(file, { timeout: ctx.timeoutMs }))
    return
  }
  // Listening before the click, with no deadline of its own: cursor travel and a risky approval
  // (a human) come first; the wait for the chooser starts once the click is done.
  let onChooser: ((c: FileChooser) => void) | undefined
  const chosen = new Promise<FileChooser>((resolve) => {
    onChooser = resolve
    ctx.page.once("filechooser", resolve)
  })
  let picked: FileChooser | undefined
  try {
    await clickAtCursor(ctx, target, step, {
      action: "click",
      target: action.target,
      ...(action.risky !== undefined && { risky: action.risky }),
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ctx.timeoutMs)
    })
    try {
      picked = await Promise.race([chosen, timeout])
    } finally {
      clearTimeout(timer)
    }
  } finally {
    if (onChooser !== undefined) ctx.page.off("filechooser", onChooser)
  }
  if (picked === undefined) {
    throw new StepError(step, "action-failed", "clicking the target didn't open a file chooser")
  }
  const chooser = picked
  await guard(step, () => chooser.setFiles(file, { timeout: ctx.timeoutMs }))
}

function timeoutOf(ctx: Ctx, stepTimeout: number | undefined): number {
  return Math.max(MIN_TIMEOUT_MS, stepTimeout ?? ctx.timeoutMs)
}

async function find(ctx: Ctx, target: Target, step: StepRef): Promise<Locator> {
  const result = await guard(step, () => resolveTarget(ctx.page, target, ctx.timeoutMs))
  if (!result.ok) throw new StepError(step, result.reason, result.detail)
  if (result.fallbackIndex !== undefined) {
    ctx.options.onEvent?.({ kind: "target_fallback", step, fallbackIndex: result.fallbackIndex })
  }
  // Auto-scroll into view (smooth, human-like scrolling comes with P0-4).
  await guard(step, () => result.locator.scrollIntoViewIfNeeded({ timeout: ctx.timeoutMs }))
  return result.locator
}

async function resolveSecret(ctx: Ctx, name: string, step: StepRef): Promise<string> {
  if (ctx.options.resolveSecret === undefined) {
    throw new StepError(
      step,
      "secret-unavailable",
      `secret "${name}" needed but no secret resolver given`,
    )
  }
  try {
    const value = await ctx.options.resolveSecret(name)
    if (value !== "") ctx.secretValues.add(value)
    return value
  } catch {
    // Never include the resolver's error: its message could contain the value.
    throw new StepError(step, "secret-unavailable", `secret "${name}" is unavailable`)
  }
}

/**
 * Scrolls a scroller explicitly instead of sending wheel events wherever the mouse happens to be
 * (which could scroll a sidebar clicked earlier). The scroller is the `within` container, or else
 * the page's main scroller: the document when it scrolls, otherwise the largest visible scrollable
 * element (app-shell layouts, where `<body>` doesn't scroll and a `<main>` pane does).
 * Smooth, human-like scrolling comes with P0-4; here it's instant and deterministic.
 */
async function scroll(ctx: Ctx, action: Extract<AnyAction, { action: "scroll" }>, step: StepRef) {
  if (action.to !== undefined) {
    await find(ctx, action.to, step)
    return
  }
  const within = action.within
  // The scroller is detected once per action and reused (a full style scan per scroll is costly),
  // and re-detected if the app re-mounts it.
  let handle: ElementHandle<Element> | undefined
  let container: Locator | undefined
  const scroller = async (): Promise<Locator | ElementHandle<Element>> => {
    if (within !== undefined) {
      container ??= await find(ctx, within, step)
      return container
    }
    if (
      handle === undefined ||
      !(await handle.evaluate((el) => el.isConnected).catch(() => false))
    ) {
      await handle?.dispose().catch(() => undefined)
      handle = (await ctx.page.evaluateHandle(findMainScroller)).asElement() ?? undefined
      if (handle === undefined) throw new Error("no scrollable element found")
    }
    return handle
  }
  const scrollInPage = (el: Element, y: number) => {
    const isDocument = el === (document.scrollingElement ?? document.documentElement)
    const before = el.scrollTop
    el.scrollBy({ top: y, behavior: "instant" })
    const rect = isDocument ? { top: 0 } : el.getBoundingClientRect()
    return {
      moved: el.scrollTop !== before,
      height: isDocument ? innerHeight : el.clientHeight,
      contentHeight: el.scrollHeight,
      top: rect.top,
    }
  }
  /** Scrolls by dy; returns whether anything moved and the scroller's visible area. */
  const scrollBy = (dy: number) =>
    guard(step, async () => {
      const s = await scroller()
      return "filter" in s
        ? s.evaluate(scrollInPage, dy, { timeout: ctx.timeoutMs })
        : s.evaluate(scrollInPage, dy)
    })
  try {
    if (action.by !== undefined) {
      await scrollBy(action.by.y)
      return
    }
    if (action.until !== undefined) await scrollUntil(ctx, action.until, step, scrollBy)
  } finally {
    await handle?.dispose().catch(() => undefined)
  }
}

/** What a scroll reports: whether it moved, and the scroller's visible area and content height. */
interface ScrollState {
  moved: boolean
  height: number
  contentHeight: number
  top: number
}

/**
 * Scrolls a "page" (80% of the scroller's height) at a time until the target is on screen:
 * towards the target when it's in the DOM (up if it's above the scroller's visible area), else
 * downwards. At the end of the content, waits for lazily loaded content once before giving up.
 */
async function scrollUntil(
  ctx: Ctx,
  until: Target,
  step: StepRef,
  scrollBy: (dy: number) => Promise<ScrollState>,
) {
  const first = await scrollBy(0)
  const step80 = Math.max(40, Math.round(first.height * 0.8))
  const deadline = Date.now() + ctx.timeoutMs
  let lazyRetry = true
  let lastDirection = 0
  let reversals = 0
  let reportedFallback = false
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) {
      throw new StepError(
        step,
        "target-not-found",
        `target not on screen after scrolling for ${ctx.timeoutMs} ms`,
      )
    }
    // One polling round per page (no waiting): the scroll itself is what makes the target appear.
    const result = await guard(step, () => resolveTarget(ctx.page, until, 0))
    if (result.ok && result.fallbackIndex !== undefined && !reportedFallback) {
      reportedFallback = true
      ctx.options.onEvent?.({ kind: "target_fallback", step, fallbackIndex: result.fallbackIndex })
    }
    if (!result.ok && result.reason !== "target-not-found")
      throw new StepError(step, result.reason, result.detail)
    let direction = 1
    if (result.ok) {
      if (
        await guard(step, () =>
          isOnScreen(ctx.page, result.locator, Math.max(MIN_TIMEOUT_MS, left)),
        )
      )
        return
      const area = await scrollBy(0)
      const box = await result.locator
        .boundingBox({ timeout: Math.max(MIN_TIMEOUT_MS, left) })
        .catch(() => null)
      if (box !== null && box.y + box.height / 2 < area.top) direction = -1
    }
    // A target that's in view but covered (sticky header, banner) makes the direction flip every
    // round: after two reversals, stop and say so instead of swinging until the timeout.
    if (result.ok && lastDirection !== 0 && direction !== lastDirection) reversals++
    if (reversals >= 2) {
      throw new StepError(
        step,
        "target-not-found",
        "target is in the page but stays off screen (covered, or in another scroller: use `within`)",
      )
    }
    lastDirection = direction
    const { moved } = await scrollBy(direction * step80)
    if (moved) {
      lazyRetry = true
      continue
    }
    if (result.ok) {
      throw new StepError(
        step,
        "target-not-found",
        "target is in the page but stays off screen (covered, or in another scroller: use `within`)",
      )
    }
    // At the end of the content: infinite lists load the next page now. Let it settle once.
    if (!lazyRetry) {
      throw new StepError(
        step,
        "target-not-found",
        "scrolled until the end, target never appeared on screen",
      )
    }
    lazyRetry = false
    // Wait (bounded) for the content to grow: the next page of an infinite list is being loaded.
    const { contentHeight } = await scrollBy(0)
    const growDeadline = Date.now() + Math.min(2000, Math.max(0, deadline - Date.now()))
    while (Date.now() < growDeadline && (await scrollBy(0)).contentHeight <= contentHeight) {
      await ctx.page.waitForTimeout(100)
    }
  }
}

/**
 * The page's main scroller: the document when it scrolls, otherwise the largest visible scrollable
 * element (app-shell layouts, where `<body>` doesn't scroll and a `<main>` pane does). Runs in the page.
 */
function findMainScroller(): Element {
  const doc = document.scrollingElement ?? document.documentElement
  const docScrolls =
    doc.scrollHeight > innerHeight + 1 &&
    getComputedStyle(document.documentElement).overflowY !== "hidden" &&
    getComputedStyle(document.body).overflowY !== "hidden"
  if (docScrolls) return doc
  let best: Element = doc
  let bestArea = 0
  for (const el of document.querySelectorAll("*")) {
    const { overflowY } = getComputedStyle(el)
    if (!/(auto|scroll|overlay)/.test(overflowY) || el.scrollHeight <= el.clientHeight + 1) continue
    const r = el.getBoundingClientRect()
    const area =
      Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
      Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0))
    if (area > bestArea) {
      bestArea = area
      best = el
    }
  }
  return best
}

/** Signals a condition that timed out without a Playwright TimeoutError (network idle). */
class ConditionTimeout extends Error {}

async function waitForCondition(
  ctx: Ctx,
  condition: Condition,
  timeout: number,
  step: StepRef,
  reason: "condition-timeout" | "expectation-failed",
) {
  const { page } = ctx
  const what = describeCondition(condition)
  try {
    if ("visible" in condition) {
      // Any VISIBLE match counts (a hidden template of the same element doesn't block).
      await visibleOnly(toPlaywright(page, condition.visible))
        .first()
        .waitFor({ state: "visible", timeout })
    } else if ("hidden" in condition) {
      // Hidden = no visible match left.
      await visibleOnly(toPlaywright(page, condition.hidden))
        .first()
        .waitFor({ state: "detached", timeout })
    } else if ("text" in condition) {
      await visibleOnly(page.getByText(condition.text))
        .first()
        .waitFor({ state: "visible", timeout })
    } else if ("url" in condition) {
      const expected = new URL(condition.url, ctx.base)
      await page.waitForURL((url) => urlMatches(url, expected), { timeout })
    } else if (!(await ctx.network.waitForIdle(timeout))) {
      throw new ConditionTimeout()
    }
  } catch (cause) {
    // Only a timeout means "the condition wasn't met"; anything else (page closed, crashed…) is
    // reported as an action failure with its cause, so it isn't mistaken for a locator problem.
    if (
      cause instanceof ConditionTimeout ||
      (cause instanceof Error && cause.name === "TimeoutError")
    ) {
      throw new StepError(step, reason, `${what} (after ${timeout} ms)`)
    }
    throw new StepError(step, "action-failed", firstLine(cause), { cause })
  }
}

function describeCondition(condition: Condition): string {
  if ("visible" in condition) return `${describeLocator(condition.visible)} never became visible`
  if ("hidden" in condition) return `${describeLocator(condition.hidden)} never disappeared`
  if ("text" in condition) return `text "${condition.text}" never appeared`
  if ("url" in condition) return `URL never matched ${condition.url}`
  return "network never went idle"
}

/**
 * URL condition: same origin, the path equals the expected path or continues it at a segment
 * boundary (`/projects/1` matches `/projects/1` and `/projects/1/edit`, not `/projects/12`); the root
 * `/` only matches the root itself. Every expected query parameter must be present with its value,
 * and an expected `#hash` (hash-routed apps) is matched the same way as a path.
 */
export function urlMatches(actual: URL, expected: URL): boolean {
  if (actual.origin !== expected.origin) return false
  if (!pathMatches(actual.pathname, expected.pathname)) return false
  for (const [key, value] of expected.searchParams) {
    if (!actual.searchParams.getAll(key).includes(value)) return false
  }
  if (expected.hash !== "") {
    // Hash routes (`#/projects?tab=members`) have their own path and query.
    const want = new URL(expected.hash.slice(1), "http://hash.invalid")
    const have = new URL(actual.hash.slice(1), "http://hash.invalid")
    if (!pathMatches(have.pathname, want.pathname)) return false
    for (const [key, value] of want.searchParams) {
      if (!have.searchParams.getAll(key).includes(value)) return false
    }
  }
  return true
}

function pathMatches(actual: string, expected: string): boolean {
  const want = expected.replace(/\/+$/, "")
  const path = actual.replace(/\/+$/, "")
  if (want === "") return path === ""
  return path === want || path.startsWith(`${want}/`)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Seed of a step's random motion: the same step always moves the same way. */
function seedOf(step: StepRef): string {
  return `${step.phase}:${step.stepId ?? step.index}`
}

/**
 * Moves the real mouse to a point inside the target along a human-like path (so hover states happen
 * in the app), reporting cursor samples. Off camera, or with `cursor: instant`, it jumps. Returns
 * the point it stopped on, where the action then happens.
 */
async function moveCursorTo(
  ctx: Ctx,
  target: Locator,
  step: StepRef,
  { correction = false }: { correction?: boolean } = {},
): Promise<Point | undefined> {
  return guard(step, async () => {
    const viewport = await viewportOf(ctx.page)
    const onCamera = step.phase === "steps" && ctx.pacing.cursor !== "instant"
    const pacing = !onCamera ? "instant" : correction ? "fast" : ctx.pacing.cursor
    const random = seededRandom(`${seedOf(step)}:cursor${correction ? ":again" : ""}`)
    // No box (display: contents, re-rendering…): skip the visual movement, the action still runs.
    const visible = visiblePart(await target.boundingBox({ timeout: ctx.timeoutMs }), viewport)
    if (visible === undefined) return undefined
    const to = clickPoint(visible, random)
    await travel(
      ctx,
      step,
      planPath(ctx.cursor ?? center(viewport), to, {
        pacing,
        targetWidth: visible.width,
        viewport,
        random,
      }),
    )
    return ctx.cursor
  })
}

/**
 * Clicks where the cursor is:
 * 1. the cursor travels to a point on the target (visuals only);
 * 2. a probe at that point checks it's on the target (one re-aim otherwise; if it's still covered,
 *    Playwright picks the point) and reads what the press would activate, after hover: if it
 *    mentions a risky word, the click needs approval (fails closed, `risky: false` opts out);
 * 3. Playwright's own `click({ position })` does the rest: actionability at that point, the
 *    hit-target check at dispatch, modifiers, and waiting for a navigation the click starts.
 * The time budget covers the click itself, not the cursor travel nor the human approval wait.
 */
async function clickAtCursor(
  ctx: Ctx,
  target: Locator,
  step: StepRef,
  action: Extract<AnyAction, { action: "click" }>,
): Promise<void> {
  let point = await moveCursorTo(ctx, target, step)
  let deadline = Date.now() + ctx.timeoutMs
  const left = () => Math.max(MIN_TIMEOUT_MS, deadline - Date.now())
  // A token marks the element found under the point, so a later probe can tell it's the SAME node.
  const token = `${seedOf(step)}:${Date.now()}`
  const probeAt = (p: Point) =>
    target.evaluate(pointProbe, [p.x, p.y, true, false, token] as ProbeArgs, { timeout: left() })
  await guard(step, async () => {
    let probe = point === undefined ? undefined : await probeAt(point)
    if (point !== undefined && probe !== undefined && !probe.hits) {
      point = (await moveCursorTo(ctx, target, step, { correction: true })) ?? point
      deadline = Date.now() + ctx.timeoutMs // the corrective travel doesn't count either
      probe = await probeAt(point)
      // Still covered at our point: let Playwright choose one (it reports interceptions clearly).
      if (!probe.hits) point = undefined
    }
    // `point` defined ⇔ a verified point on the target, with `probe` describing what it activates.
    if (action.risky === undefined) {
      const risky =
        point === undefined || probe === undefined ? null : RISKY_LABEL.exec(probe.label)
      const detail =
        point === undefined
          ? "can't see what this click would activate: approve it, or set `risky: false`"
          : risky !== null
            ? `this click activates something that mentions "${risky[0]}": approve it, or set \`risky: false\` if it's safe`
            : undefined
      if (detail !== undefined) {
        await requireApproval(ctx, step, detail)
        deadline = Date.now() + ctx.timeoutMs // the human wait doesn't count
        // The page may have changed while waiting: the point must still be on the target, on the
        // very element that was approved (not another row with the same words).
        const words = (label: string) =>
          [...label.matchAll(new RegExp(RISKY_LABEL.source, "gi"))]
            .map((m) => m[0].toLowerCase())
            .sort()
            .join(",")
        const now = point === undefined ? undefined : await probeAt(point)
        if (
          now !== undefined &&
          probe !== undefined &&
          (!now.sameAsMarked || words(now.label) !== words(probe.label))
        ) {
          throw new StepError(
            step,
            "action-failed",
            "the page changed while waiting for approval: nothing was clicked",
          )
        }
      }
    }
    let position: Point | undefined
    let box: Box | null = null
    if (point !== undefined) {
      box = await target.boundingBox({ timeout: left() })
      // The box vanished after the check: never fall back to the element's center, which wasn't
      // checked (it could be the Delete button in the middle of a card).
      if (box === null)
        throw new StepError(
          step,
          "action-failed",
          "the target changed right before the click: nothing was clicked",
        )
      position = await clickOffset(target, box, point, left())
    }
    // The click event the recorder logs, at our point or the box center when Playwright picks it.
    // No trial click first: Playwright's trial really presses the mouse (the button would flash
    // twice on camera). A click that then fails fails the step, and so the take: no phantom click.
    if (ctx.options.onEvent !== undefined && ctx.options.recording === true) {
      const clickBox = box ?? (await target.boundingBox({ timeout: left() }).catch(() => null))
      if (clickBox !== null) {
        const where = point ?? {
          x: clickBox.x + clickBox.width / 2,
          y: clickBox.y + clickBox.height / 2,
        }
        ctx.options.onEvent({
          kind: "click",
          step,
          ...where,
          box: clickBox,
          button: action.button ?? "left",
          count: action.count ?? 1,
        })
      }
    }
    const at = point
    const emit = (pressed: boolean) => {
      if (at !== undefined) ctx.options.onEvent?.({ kind: "cursor", step, ...at, pressed })
    }
    // One press/release pair per click (a double click shows two ripples); the last release comes
    // after Playwright's click.
    for (let i = 1; i < (action.count ?? 1); i++) {
      emit(true)
      emit(false)
    }
    emit(true)
    let clickError: Error | undefined
    try {
      await target.click({
        timeout: left(),
        ...(position !== undefined && { position }),
        ...(action.button !== undefined && { button: action.button }),
        ...(action.count !== undefined && { clickCount: action.count }),
        ...(action.modifiers !== undefined && {
          modifiers: action.modifiers.map(toPlaywrightModifier),
        }),
      })
    } catch (error) {
      clickError = error instanceof Error ? error : new Error(String(error))
    }
    try {
      emit(false)
    } catch (error) {
      // The click's own error wins; a failing release callback fails the step only on its own.
      if (clickError === undefined) throw error
    }
    if (clickError !== undefined) throw clickError
  })
}

/**
 * The click `position` for a point on screen. Playwright measures it from the element's padding
 * box: it adds parseInt(border width), so exactly that is subtracted and the click lands on `at`.
 */
async function clickOffset(
  target: Locator,
  box: { x: number; y: number },
  at: Point,
  timeout: number,
): Promise<Point> {
  const border = await target.evaluate(
    (el) => {
      const style = getComputedStyle(el)
      return {
        left: parseInt(style.borderLeftWidth, 10) || 0,
        top: parseInt(style.borderTopWidth, 10) || 0,
      }
    },
    undefined,
    { timeout },
  )
  return { x: at.x - box.x - border.left, y: at.y - box.y - border.top }
}

const center = (viewport: { width: number; height: number }): Point => ({
  x: viewport.width / 2,
  y: viewport.height / 2,
})

/**
 * The part of a box that's inside the viewport (a tall textarea or a board can be bigger than the
 * screen): the cursor aims there, never off screen. Undefined if nothing is visible.
 */
function visiblePart(
  box: { x: number; y: number; width: number; height: number } | null,
  viewport: { width: number; height: number },
) {
  if (box === null) return undefined
  const x = Math.max(0, box.x)
  const y = Math.max(0, box.y)
  const width = Math.min(viewport.width, box.x + box.width) - x
  const height = Math.min(viewport.height, box.y + box.height) - y
  return width > 0 && height > 0 ? { x, y, width, height } : undefined
}

/** Plays a planned path with the real mouse, in real time, reporting cursor samples. */
async function travel(
  ctx: Ctx,
  step: StepRef,
  path: { t: number; x: number; y: number }[],
  pressed = false,
) {
  const start = Date.now()
  for (const sample of path) {
    const wait = start + sample.t - Date.now()
    if (wait > 0) await sleep(wait)
    await ctx.page.mouse.move(sample.x, sample.y)
    ctx.options.onEvent?.({ kind: "cursor", step, x: sample.x, y: sample.y, pressed })
  }
  const end = path.at(-1)
  if (end !== undefined) ctx.cursor = { x: end.x, y: end.y }
}

/** How `value` appears in a URL path (WHATWG path percent-encoding), or undefined if it can't. */
function urlPath(value: string): string | undefined {
  // Per character, never through the URL parser: it would cut the value at ? or # and resolve ".."
  // (a secret "p#Kd93!x" must not become the pattern "p").
  try {
    return value.replace(/[^\x21-\x7e]|["#<>?`{}]/gu, (c) => encodeURIComponent(c))
  } catch {
    return undefined
  }
}

/**
 * Replaces every known secret value in `text` (as-is and in its common encodings: URL-encoded,
 * form-encoded, base64, JSON-escaped) with `[secret]`.
 */
export function scrubSecrets(text: string, values: Iterable<string>): string {
  const variants = new Set<string>()
  const encode = (f: (s: string) => string, s: string): string | undefined => {
    try {
      return f(s)
    } catch {
      return undefined // a lone surrogate can't be URI-encoded: the raw value is still matched
    }
  }
  for (const value of values) {
    const component = encode(encodeURIComponent, value)
    // WHATWG application/x-www-form-urlencoded (what browsers use for GET forms): also encodes !'()~
    const form = new URLSearchParams({ v: value }).toString().slice(2)
    const base64 = Buffer.from(value).toString("base64")
    const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
    for (const v of [
      value,
      component,
      component?.replace(/%20/g, "+"),
      form,
      // Encoded twice (a URL inside a `?next=` / `?return=` parameter).
      component === undefined ? undefined : encode(encodeURIComponent, component),
      encode(encodeURIComponent, form),
      encode(encodeURI, value),
      // WHATWG path encoding (what a URL's pathname holds): leaves |[]^ as they are, unlike encodeURI.
      urlPath(value),
      base64,
      encode(encodeURIComponent, base64),
      base64url,
      JSON.stringify(value).slice(1, -1),
    ]) {
      if (v !== undefined && v !== "") variants.add(v)
    }
  }
  // One pass over one alternation of every variant of every secret, longest first: a secret that
  // contains another ("password123", "pass") is replaced whole, and a replacement is never re-scanned
  // (no "[[sec]ret]"). Case-insensitive: percent-encodings are (%2F = %2f), and over-scrubbing is safe.
  if (variants.size === 0) return text
  const alternation = [...variants]
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")
  return text.replace(new RegExp(alternation, "gi"), "[secret]")
}

/** `https://host/path?query#hash` → `https://host/path` (non-URLs are returned as they are). */
export function pathOnly(url: string): string {
  const parsed = URL.parse(url)
  if (parsed === null) return url
  // blob:, data:, about:, javascript:… have no meaningful origin/path: only the scheme is kept
  // (never a data: payload).
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol
  return `${parsed.origin}${parsed.pathname}`
}

/** A secret is never typed outside the target app (a redirect may have left it, e.g. SSO). */
function assertSecretOrigin(ctx: Ctx, secret: string | undefined, step: StepRef) {
  if (secret === undefined) return
  const origin = new URL(ctx.page.url()).origin
  // Per-secret origin binding comes with the vault (APPROACHES §7.4).
  if (origin !== ctx.base.origin) {
    throw new StepError(step, "off-origin", `refusing to type secret "${secret}" on ${origin}`)
  }
}

/**
 * Puts the caret at the end of the field (runs in the page). Not the End key: on macOS it scrolls
 * instead of moving the caret, and in a textarea it only goes to the end of the current line. Some
 * input types (email, number, date…) don't support selection: typing there appends anyway.
 */
function moveCaretToEnd(el: Element) {
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    el.selectionStart !== null
  ) {
    const end = el.value.length
    el.setSelectionRange(end, end)
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
}

/** The same error with its message (and a StepError's detail) scrubbed of secret values; no cause kept. */
function scrubError(error: Error, secrets: Set<string>): Error {
  if (secrets.size === 0) return error
  // Rebuilt even when the message is clean: the cause (Playwright's full call log) could hold a secret.
  const message = scrubSecrets(error.message, secrets)
  if (error instanceof StepError)
    return new StepError(error.step, error.reason, scrubSecrets(error.detail, secrets))
  const scrubbed = new Error(message)
  scrubbed.name = error.name // e.g. TimeoutError: callers may branch on it
  return scrubbed
}

/** First line of an error's message (Playwright errors carry long call logs after it). */
export function firstLine(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.split("\n")[0] || "action failed"
}

/** Runs a Playwright call and turns its failure into a StepError on this step. */
async function guard<T>(step: StepRef, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    if (cause instanceof StepError) throw cause
    throw new StepError(step, "action-failed", firstLine(cause), { cause })
  }
}

/** `Mod` = ⌘ on Mac, Ctrl elsewhere (Playwright's ControlOrMeta). */
function modKey(key: string): string {
  return key === "Mod" ? "ControlOrMeta" : key
}

function toPlaywrightModifier(m: "Alt" | "Control" | "Meta" | "Shift" | "Mod") {
  return modKey(m) as "Alt" | "Control" | "Meta" | "Shift" | "ControlOrMeta"
}

function toPlaywrightKeys(keys: string): string {
  return keys.split("+").map(modKey).join("+")
}
