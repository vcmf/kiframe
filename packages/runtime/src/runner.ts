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
import type { ElementHandle, Frame, Locator, Page } from "playwright"
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
  /** Timeout of a `goto` navigation (page load). Default 30000 ms. */
  navigationTimeoutMs?: number
}

type AnyAction = Action | Step

/** Delay between keystrokes of on-camera typing (human-like pacing comes with P0-4). */
const TYPING_DELAY_MS = 30

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
  // Static config errors (unknown preset, unsupported `ensure`) fail BEFORE anything runs or is
  // attached to the page, and don't trigger teardown: nothing was created, and teardown could delete
  // pre-existing data.
  const setup = expandSetup(scenario.setup ?? [], project)
  const base = new URL(project.target.url)
  const settleMs = scenario.overrides?.pacing?.settleMs ?? project.defaults.pacing.settleMs
  const network = new NetworkTracker(page)
  // Every main-frame navigation is reported (goto, redirects, links clicked…), attributed to the
  // step running at that moment.
  let current: StepRef | undefined
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame() && current !== undefined) {
      options.onEvent?.({ kind: "navigate", step: current, url: frame.url() })
    }
  }
  page.on("framenavigated", onNavigated)
  const ctx: Ctx = {
    page,
    base,
    settleMs,
    options,
    network,
    setCurrent: (step) => (current = step),
    timeoutMs: Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? 5000),
    navigationTimeoutMs: Math.max(MIN_TIMEOUT_MS, options.navigationTimeoutMs ?? 30_000),
  }
  try {
    let failure: Error | undefined
    try {
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
      const reported =
        error instanceof StepError
          ? error
          : new StepError(
              { phase: "teardown", index: 0, action: "teardown" },
              "action-failed",
              firstLine(error),
              {
                cause: error,
              },
            )
      options.onEvent?.({ kind: "teardown_failed", error: reported })
    }
    if (failure !== undefined) throw failure
  } finally {
    network.dispose()
    page.off("framenavigated", onNavigated)
  }
}

interface Ctx {
  page: Page
  base: URL
  settleMs: number
  timeoutMs: number
  navigationTimeoutMs: number
  network: NetworkTracker
  setCurrent: (step: StepRef | undefined) => void
  options: RunOptions
}

/**
 * Inlines presets into setup. `ensure` items are handled in P0-9: rejected clearly for now. Error
 * indexes are post-expansion, like the `setup[i]` of runtime errors.
 */
function expandSetup(items: readonly SetupItem[], project: ProjectConfig): Action[] {
  const out: Action[] = []
  const invalid = (detail: string) =>
    new StepError({ phase: "setup", index: out.length, action: "setup" }, "invalid-setup", detail)
  for (const item of items) {
    if ("preset" in item) {
      const preset = Object.hasOwn(project.presets, item.preset)
        ? project.presets[item.preset]
        : undefined
      if (preset === undefined) throw invalid(`unknown preset "${item.preset}"`)
      for (const s of preset.steps) {
        if ("ensure" in s)
          throw invalid("`ensure` isn't supported by the Phase 0 runner yet (P0-9)")
        out.push(s)
      }
    } else if ("ensure" in item) {
      throw invalid("`ensure` isn't supported by the Phase 0 runner yet (P0-9)")
    } else {
      out.push(item)
    }
  }
  return out
}

/** Runs one action. Every failure, including from callbacks, is a StepError naming this step. */
async function runOne(ctx: Ctx, action: AnyAction, step: StepRef): Promise<void> {
  ctx.setCurrent(step)
  if (action.risky === true) {
    const approved = await guard(
      step,
      async () => (await ctx.options.approveRisky?.(step)) ?? false,
    )
    if (!approved) throw new StepError(step, "risky-not-approved", "risky step needs approval")
  }
  ctx.options.onEvent?.({ kind: "step_start", step })
  await perform(ctx, action, step)
  if (action.action !== "pause") await guard(step, () => settle(ctx))
  ctx.options.onEvent?.({ kind: "step_end", step })
}

/** Upper bound of each settle wait: pages with constant activity (animations, polling) never block. */
const SETTLE_MAX_MS = 3000

/**
 * After an action, wait for the app to settle (docs/OBJECT-MODEL.md §2b): no request in flight and
 * no DOM mutation for a short quiet period, then the project's extra `settleMs`. Each wait is
 * bounded and never fails the step.
 */
async function settle(ctx: Ctx): Promise<void> {
  // Network and DOM are independent: wait for both at once, so the worst case is one cap.
  await Promise.all([ctx.network.waitForIdle(SETTLE_MAX_MS, 200), domQuiet(ctx)])
  if (ctx.settleMs > 0) await ctx.page.waitForTimeout(ctx.settleMs)
}

async function domQuiet(ctx: Ctx): Promise<void> {
  await ctx.page
    .evaluate(
      ({ quiet, max }) =>
        new Promise<void>((resolve) => {
          let timer = setTimeout(done, quiet)
          const observer = new MutationObserver(() => {
            clearTimeout(timer)
            timer = setTimeout(done, quiet)
          })
          const cap = setTimeout(done, max)
          function done() {
            observer.disconnect()
            clearTimeout(timer)
            clearTimeout(cap)
            resolve()
          }
          observer.observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          })
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
      // A secret is never typed outside the target app (a redirect may have left it, e.g. SSO).
      // Per-secret origin binding comes with the vault (APPROACHES §7.4).
      if (secret !== undefined && new URL(page.url()).origin !== ctx.base.origin) {
        throw new StepError(
          step,
          "off-origin",
          `refusing to type secret "${secret}" on ${new URL(page.url()).origin}`,
        )
      }
      const text = secret === undefined ? action.value : await resolveSecret(ctx, secret, step)
      await guard(step, async () => {
        const timeout = ctx.timeoutMs
        // Same semantics on and off camera: the text is added at the end of the field's content,
        // unless `clear` empties the field first.
        if (action.clear === true) await target.fill("", { timeout })
        await target.focus({ timeout })
        // Not the End key: on macOS it scrolls instead of moving the caret, and in a textarea
        // it only goes to the end of the current line.
        await target.evaluate(
          (el) => {
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
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
          },
          undefined,
          { timeout },
        )
        if (action.instant === true || secret !== undefined) {
          await page.keyboard.insertText(text)
        } else {
          // Playwright's timeout covers the whole typing: give it the keystroke time on top.
          const typing = text.length * TYPING_DELAY_MS
          await target.pressSequentially(text, {
            delay: TYPING_DELAY_MS,
            timeout: timeout + typing,
          })
        }
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
      await guard(step, () => page.waitForTimeout(action.ms))
      return
  }
}

function timeoutOf(ctx: Ctx, stepTimeout: number | undefined): number {
  return Math.max(MIN_TIMEOUT_MS, stepTimeout ?? ctx.timeoutMs)
}

async function find(ctx: Ctx, target: Target, step: StepRef): Promise<Locator> {
  const result = await guard(step, () => resolveTarget(ctx.page, target, ctx.timeoutMs))
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
  const scroller = async (): Promise<Locator | ElementHandle<Element>> => {
    if (within !== undefined) return find(ctx, within, step)
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
    const rect = isDocument ? { top: 0, bottom: innerHeight } : el.getBoundingClientRect()
    return {
      moved: el.scrollTop !== before,
      height: isDocument ? innerHeight : el.clientHeight,
      contentHeight: el.scrollHeight,
      top: rect.top,
      bottom: rect.bottom,
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
  bottom: number
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
  if (expected.hash !== "" && !pathMatches(actual.hash.slice(1), expected.hash.slice(1)))
    return false
  return true
}

function pathMatches(actual: string, expected: string): boolean {
  const want = expected.replace(/\/+$/, "")
  const path = actual.replace(/\/+$/, "")
  if (want === "") return path === ""
  return path === want || path.startsWith(`${want}/`)
}

/** First line of an error's message (Playwright errors carry long call logs after it). */
function firstLine(cause: unknown): string {
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
  return m === "Mod" ? ("ControlOrMeta" as const) : m
}

function toPlaywrightKeys(keys: string): string {
  return keys.split("+").map(modKey).join("+")
}
