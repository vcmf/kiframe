import type {
  Action,
  Condition,
  ProjectConfig,
  Scenario,
  SetupItem,
  Step,
  Target,
} from "@kiframe/schema"
import { secretRefName } from "@kiframe/schema"
import type { Locator, Page } from "playwright"
import { StepError, type StepRef } from "./errors.ts"
import { NetworkTracker } from "./network.ts"
import { describeLocator, isOnScreen, resolveTarget, toPlaywright, visibleOnly } from "./targets.ts"

// Runs one scene's scenario against a live page (docs/OBJECT-MODEL.md §2–2b): setup (presets
// expanded), steps, teardown. Phase 0 scope: no human motion yet (P0-4), no recording (P0-5), no
// `ensure` / session reuse (P0-9).

/** What the runner reports as it goes. The recorder (P0-5) turns these into take events. */
export type RunnerEvent =
  | { kind: "step_start" | "step_end"; step: StepRef }
  | { kind: "navigate"; step: StepRef; url: string }
  /** `secret` is the secret NAME when the value came from the vault; the value is never reported. */
  | { kind: "type"; step: StepRef; secret?: string | undefined }
  /** Teardown failed after a step had already failed: the step's error is the one thrown. */
  | { kind: "teardown_failed"; error: StepError }

export interface RunOptions {
  /** Resolves a secret NAME to its value, at the moment of the fill. Throw if unavailable. */
  resolveSecret?: (name: string) => string | Promise<string>
  /** Called for every runner event. Must not throw. */
  onEvent?: (event: RunnerEvent) => void
  /** Risky steps (delete, send, pay…) run only if this returns true (approval / sandbox, §7.2). */
  approveRisky?: (step: StepRef) => boolean | Promise<boolean>
  /** Per-step timeout for finding targets and waiting on conditions. Default 5000 ms. */
  timeoutMs?: number
}

type AnyAction = Action | Step

/** Playwright treats a timeout of 0 as "wait forever": never pass it through. */
const MIN_TIMEOUT_MS = 1

/**
 * Runs a scenario. Throws a `StepError` naming the failing step. Teardown runs even when a step
 * fails (so the scene cleans up what it created); a teardown failure after a step failure is
 * reported as a `teardown_failed` event and the step's error is thrown.
 */
export async function runScenario(
  page: Page,
  scenario: Scenario,
  project: ProjectConfig,
  options: RunOptions = {},
): Promise<void> {
  const base = new URL(project.target.url)
  const settleMs = scenario.overrides?.pacing?.settleMs ?? project.defaults.pacing.settleMs
  const network = new NetworkTracker(page)
  const ctx: Ctx = {
    page,
    base,
    settleMs,
    options,
    network,
    timeoutMs: Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? 5000),
  }
  try {
    let failure: Error | undefined
    try {
      const setup = expandSetup(scenario.setup ?? [], project)
      for (const [index, action] of setup.entries()) {
        await runOne(ctx, action, {
          phase: "setup",
          index,
          stepId: action.id,
          action: action.action,
        })
      }
      for (const [index, step] of scenario.steps.entries()) {
        await runOne(ctx, step, { phase: "steps", index, stepId: step.id, action: step.action })
      }
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error))
    }
    try {
      for (const [index, action] of (scenario.teardown ?? []).entries()) {
        await runOne(ctx, action, {
          phase: "teardown",
          index,
          stepId: action.id,
          action: action.action,
        })
      }
    } catch (error) {
      if (failure === undefined) throw error
      if (error instanceof StepError) options.onEvent?.({ kind: "teardown_failed", error })
    }
    if (failure !== undefined) throw failure
  } finally {
    network.dispose()
  }
}

interface Ctx {
  page: Page
  base: URL
  settleMs: number
  timeoutMs: number
  network: NetworkTracker
  options: RunOptions
}

/** Inlines presets into setup. `ensure` items are handled in P0-9: rejected clearly for now. */
function expandSetup(items: readonly SetupItem[], project: ProjectConfig): Action[] {
  const invalid = (index: number, detail: string) =>
    new StepError({ phase: "setup", index, action: "setup" }, "invalid-setup", detail)
  return items.flatMap((item, index): Action[] => {
    if ("preset" in item) {
      const preset = Object.hasOwn(project.presets, item.preset)
        ? project.presets[item.preset]
        : undefined
      if (preset === undefined) throw invalid(index, `unknown preset "${item.preset}"`)
      return preset.steps.map((s) => {
        if ("ensure" in s)
          throw invalid(index, "`ensure` isn't supported by the Phase 0 runner yet (P0-9)")
        return s
      })
    }
    if ("ensure" in item)
      throw invalid(index, "`ensure` isn't supported by the Phase 0 runner yet (P0-9)")
    return [item]
  })
}

async function runOne(ctx: Ctx, action: AnyAction, step: StepRef): Promise<void> {
  if (action.risky === true) {
    const approved = (await ctx.options.approveRisky?.(step)) ?? false
    if (!approved) throw new StepError(step, "risky-not-approved", "risky step needs approval")
  }
  ctx.options.onEvent?.({ kind: "step_start", step })
  await perform(ctx, action, step)
  if (ctx.settleMs > 0 && action.action !== "pause") await ctx.page.waitForTimeout(ctx.settleMs)
  ctx.options.onEvent?.({ kind: "step_end", step })
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
        await page.goto(url.href, { waitUntil: "load", timeout: ctx.timeoutMs })
        // Input sent before the first rendered frame (e.g. a wheel) is dropped by the browser.
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        )
      })
      ctx.options.onEvent?.({ kind: "navigate", step, url: url.href })
      return
    }
    case "click": {
      const target = await find(ctx, action.target, step)
      await guard(step, () =>
        target.click({
          timeout: ctx.timeoutMs,
          ...(action.button !== undefined && { button: action.button }),
          ...(action.count !== undefined && { clickCount: action.count }),
          ...(action.modifiers !== undefined && {
            modifiers: action.modifiers.map(toPlaywrightModifier),
          }),
        }),
      )
      return
    }
    case "type": {
      const target = await find(ctx, action.target, step)
      const secret = secretRefName(action.value)
      const text = secret === undefined ? action.value : await resolveSecret(ctx, secret, step)
      await guard(step, async () => {
        const timeout = ctx.timeoutMs
        if (action.clear === true) await target.fill("", { timeout })
        if (action.instant === true || secret !== undefined) await target.fill(text, { timeout })
        else await target.pressSequentially(text, { delay: 30, timeout })
        if (action.submit === true) await target.press("Enter", { timeout })
      })
      ctx.options.onEvent?.({ kind: "type", step, secret })
      return
    }
    case "press":
      await guard(step, () => page.keyboard.press(toPlaywrightKeys(action.keys)))
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
      await page.waitForTimeout(action.ms)
      return
  }
}

function timeoutOf(ctx: Ctx, stepTimeout: number | undefined): number {
  return Math.max(MIN_TIMEOUT_MS, stepTimeout ?? ctx.timeoutMs)
}

async function find(ctx: Ctx, target: Target, step: StepRef): Promise<Locator> {
  const result = await resolveTarget(ctx.page, target, ctx.timeoutMs)
  if (!result.ok) throw new StepError(step, result.reason, result.detail)
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
    return await ctx.options.resolveSecret(name)
  } catch {
    // Never include the resolver's error: its message could contain the value.
    throw new StepError(step, "secret-unavailable", `secret "${name}" is unavailable`)
  }
}

/**
 * Scrolls the right scroller explicitly (the page, or the `within` container) instead of sending
 * wheel events wherever the mouse happens to be, which could scroll a sidebar clicked earlier.
 * Smooth, human-like scrolling comes with P0-4; here it's instant and deterministic.
 */
async function scroll(ctx: Ctx, action: Extract<AnyAction, { action: "scroll" }>, step: StepRef) {
  const container = action.within === undefined ? undefined : await find(ctx, action.within, step)
  const scrollBy = (dy: number) =>
    guard(step, async () => {
      if (container === undefined) {
        await ctx.page.evaluate((y) => window.scrollBy({ top: y, behavior: "instant" }), dy)
      } else {
        await container.evaluate((el, y) => el.scrollBy({ top: y, behavior: "instant" }), dy, {
          timeout: ctx.timeoutMs,
        })
      }
    })
  if (action.to !== undefined) {
    await find(ctx, action.to, step)
    return
  }
  if (action.by !== undefined) {
    await scrollBy(action.by.y)
    return
  }
  if (action.until !== undefined) {
    // Scroll a "page" (80% of the scroller's height) at a time until the target is on screen.
    const pageHeight = await guard(step, async () =>
      container === undefined
        ? ctx.page.evaluate(() => innerHeight)
        : ((await container.boundingBox({ timeout: ctx.timeoutMs }))?.height ?? 400),
    )
    const deadline = Date.now() + ctx.timeoutMs
    for (;;) {
      const left = deadline - Date.now()
      if (left <= 0) break
      const result = await resolveTarget(ctx.page, action.until, Math.min(250, left))
      if (
        result.ok &&
        (await isOnScreen(ctx.page, result.locator, Math.max(MIN_TIMEOUT_MS, left)))
      ) {
        return
      }
      if (!result.ok && result.reason !== "target-not-found") {
        throw new StepError(step, result.reason, result.detail)
      }
      await scrollBy(Math.max(40, Math.round(pageHeight * 0.8)))
    }
    throw new StepError(
      step,
      "target-not-found",
      "scrolled until timeout, target never appeared on screen",
    )
  }
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
    const message = cause instanceof Error ? (cause.message.split("\n")[0] ?? "") : String(cause)
    throw new StepError(step, "action-failed", message, { cause })
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
 * boundary (`/projects/1` matches `/projects/1` and `/projects/1/edit`, not `/projects/12`), and
 * every expected query parameter is present with its value.
 */
export function urlMatches(actual: URL, expected: URL): boolean {
  if (actual.origin !== expected.origin) return false
  const want = expected.pathname.replace(/\/+$/, "")
  const path = actual.pathname.replace(/\/+$/, "")
  if (want !== "" && path !== want && !path.startsWith(`${want}/`)) return false
  for (const [key, value] of expected.searchParams) {
    if (!actual.searchParams.getAll(key).includes(value)) return false
  }
  return true
}

/** Runs a Playwright call and turns its failure into a StepError on this step. */
async function guard<T>(step: StepRef, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause)
    throw new StepError(step, "action-failed", message ?? "action failed", { cause })
  }
}

/** `Mod` = ⌘ on Mac, Ctrl elsewhere (Playwright's ControlOrMeta). */
function toPlaywrightModifier(m: "Alt" | "Control" | "Meta" | "Shift" | "Mod") {
  return m === "Mod" ? "ControlOrMeta" : m
}

function toPlaywrightKeys(keys: string): string {
  return keys
    .split("+")
    .map((k) => (k === "Mod" ? "ControlOrMeta" : k))
    .join("+")
}
