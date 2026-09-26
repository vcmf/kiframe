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
import { describeLocator, isOnScreen, resolveTarget, toPlaywright } from "./targets.ts"

// Runs one scene's scenario against a live page (docs/OBJECT-MODEL.md §2–2b): setup (presets
// expanded), steps, teardown. Phase 0 scope: no human motion yet (P0-4), no recording (P0-5), no
// `ensure` / session reuse (P0-9).

/** What the runner reports as it goes. The recorder (P0-5) turns these into take events. */
export type RunnerEvent =
  | { kind: "step_start" | "step_end"; step: StepRef }
  | { kind: "navigate"; step: StepRef; url: string }
  /** `secret` is the secret NAME when the value came from the vault; the value is never reported. */
  | { kind: "type"; step: StepRef; secret?: string | undefined }

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

/** Runs a scenario. Throws a `StepError` naming the failing step. */
export async function runScenario(
  page: Page,
  scenario: Scenario,
  project: ProjectConfig,
  options: RunOptions = {},
): Promise<void> {
  const base = new URL(project.target.url)
  const settleMs = scenario.overrides?.pacing?.settleMs ?? project.defaults.pacing.settleMs
  const ctx: Ctx = { page, base, settleMs, options, timeoutMs: options.timeoutMs ?? 5000 }

  const setup = expandSetup(scenario.setup ?? [], project)
  for (const [index, action] of setup.entries()) {
    await runOne(ctx, action, { phase: "setup", index, stepId: action.id, action: action.action })
  }
  for (const [index, step] of scenario.steps.entries()) {
    await runOne(ctx, step, { phase: "steps", index, stepId: step.id, action: step.action })
  }
  for (const [index, action] of (scenario.teardown ?? []).entries()) {
    await runOne(ctx, action, {
      phase: "teardown",
      index,
      stepId: action.id,
      action: action.action,
    })
  }
}

interface Ctx {
  page: Page
  base: URL
  settleMs: number
  timeoutMs: number
  options: RunOptions
}

/** Inlines presets into setup. `ensure` items are handled in P0-9: rejected clearly for now. */
function expandSetup(items: readonly SetupItem[], project: ProjectConfig): Action[] {
  return items.flatMap((item): Action[] => {
    if ("preset" in item) {
      const preset = Object.hasOwn(project.presets, item.preset)
        ? project.presets[item.preset]
        : undefined
      if (preset === undefined) throw new Error(`setup uses unknown preset "${item.preset}"`)
      return preset.steps.map((s) => {
        if ("ensure" in s)
          throw new Error("`ensure` isn't supported by the Phase 0 runner yet (P0-9)")
        return s
      })
    }
    if ("ensure" in item)
      throw new Error("`ensure` isn't supported by the Phase 0 runner yet (P0-9)")
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
        await page.goto(url.href, { waitUntil: "load" })
        // Input sent before the first rendered frame (e.g. a wheel) is dropped by the browser.
        await page.evaluate(
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        )
      })
      ctx.options.onEvent?.({ kind: "navigate", step, url: url.href })
      return
    }
    case "click": {
      const target = await find(ctx, action.target, step)
      await guard(step, () =>
        target.click({
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
        if (action.clear === true) await target.fill("")
        if (action.instant === true || secret !== undefined) await target.fill(text)
        else await target.pressSequentially(text, { delay: 30 })
        if (action.submit === true) await target.press("Enter")
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
        action.timeout ?? ctx.timeoutMs,
        step,
        "condition-timeout",
      )
      return
    case "expect":
      await waitForCondition(
        ctx,
        action.that,
        action.timeout ?? ctx.timeoutMs,
        step,
        "expectation-failed",
      )
      return
    case "pause":
      await page.waitForTimeout(action.ms)
      return
  }
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

async function scroll(ctx: Ctx, action: Extract<AnyAction, { action: "scroll" }>, step: StepRef) {
  const { page } = ctx
  // Inside a container, the mouse sits over it (so wheel events scroll it) and a scroll "page" is
  // the container's height; otherwise it's the viewport's.
  let pageHeight = page.viewportSize()?.height ?? 800
  if (action.within !== undefined) {
    const container = await find(ctx, action.within, step)
    await guard(step, () => container.hover())
    pageHeight = (await container.boundingBox())?.height ?? pageHeight
  }
  if (action.to !== undefined) {
    await find(ctx, action.to, step)
    return
  }
  if (action.by !== undefined) {
    const { y } = action.by
    await guard(step, () => page.mouse.wheel(0, y))
    await scrollSettled(page)
    return
  }
  if (action.until !== undefined) {
    // Scroll a viewport at a time until the target shows up (Maestro's scrollUntilVisible).
    const deadline = Date.now() + ctx.timeoutMs
    while (Date.now() < deadline) {
      const result = await resolveTarget(page, action.until, 250)
      if (result.ok && (await isOnScreen(page, result.locator))) return
      if (!result.ok && result.reason !== "target-not-found") {
        throw new StepError(step, result.reason, result.detail)
      }
      await page.mouse.wheel(0, Math.max(40, Math.round(pageHeight * 0.8)))
      await scrollSettled(page)
    }
    throw new StepError(step, "target-not-found", "scrolled until timeout, target never appeared")
  }
}

async function waitForCondition(
  ctx: Ctx,
  condition: Condition,
  timeout: number,
  step: StepRef,
  reason: "condition-timeout" | "expectation-failed",
) {
  const { page } = ctx
  const fail = (what: string) => new StepError(step, reason, `${what} (after ${timeout} ms)`)
  try {
    if ("visible" in condition) {
      await toPlaywright(page, condition.visible).first().waitFor({ state: "visible", timeout })
    } else if ("hidden" in condition) {
      await toPlaywright(page, condition.hidden).first().waitFor({ state: "hidden", timeout })
    } else if ("text" in condition) {
      await page.getByText(condition.text).first().waitFor({ state: "visible", timeout })
    } else if ("url" in condition) {
      const expected = new URL(condition.url, ctx.base)
      await page.waitForURL((url) => url.href.startsWith(expected.href), { timeout })
    } else {
      await page.waitForLoadState("networkidle", { timeout })
    }
  } catch {
    if ("visible" in condition)
      throw fail(`${describeLocator(condition.visible)} never became visible`)
    if ("hidden" in condition) throw fail(`${describeLocator(condition.hidden)} never disappeared`)
    if ("text" in condition) throw fail(`text "${condition.text}" never appeared`)
    if ("url" in condition) throw fail(`URL never matched ${condition.url}`)
    throw fail("network never went idle")
  }
}

/**
 * `mouse.wheel` returns before the page has scrolled. Wait until the scroll position of the
 * document and of every scrolled element stops changing between two animation frames.
 */
async function scrollSettled(page: Page): Promise<void> {
  await page.evaluate(`new Promise((resolve) => {
    const position = () => [window.scrollX, window.scrollY,
      ...Array.from(document.querySelectorAll("*"), (el) => el.scrollTop + "," + el.scrollLeft)].join("|")
    let last = position(), stable = 0, frames = 0
    const tick = () => {
      const now = position()
      stable = now === last ? stable + 1 : 0
      last = now
      if (stable >= 3 || ++frames > 120) resolve(undefined)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })`)
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
