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
import {
  clickPoint,
  planPath,
  seededRandom,
  typingDelays,
  type CursorPacing,
  type Point,
  type TypingPacing,
} from "./motion.ts"
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
  /** The cursor moved or was pressed/released (CSS pixels of the viewport). For the recorder (P0-5). */
  | { kind: "cursor"; step: StepRef; x: number; y: number; pressed: boolean }
  /** A fallback locator was used: the primary one no longer matches (a signal for self-healing). */
  | { kind: "target_fallback"; step: StepRef; fallbackIndex: number }
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
  let listenerError: StepError | undefined
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame() && current !== undefined) {
      try {
        options.onEvent?.({ kind: "navigate", step: current, url: frame.url() })
      } catch (error) {
        // Thrown inside Playwright's event dispatch: keep it and fail the step afterwards.
        listenerError ??= new StepError(current, "action-failed", firstLine(error), {
          cause: error,
        })
      }
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
      // The step's own error is the one reported: don't let a pending listener error from the same
      // step resurface later and cut teardown short.
      ctx.clearListenerError()
      failure =
        error instanceof StepError || current === undefined
          ? (error as Error)
          : new StepError(current, "action-failed", firstLine(error), { cause: error })
    }
    for (const [index, action] of (scenario.teardown ?? []).entries()) {
      const ref: StepRef = { phase: "teardown", index, stepId: action.id, action: action.action }
      try {
        await runOne(ctx, action, ref)
      } catch (error) {
        const stepError =
          error instanceof StepError
            ? error
            : new StepError(ref, "action-failed", firstLine(error), { cause: error })
        if (failure === undefined) throw stepError
        options.onEvent?.({ kind: "teardown_failed", error: stepError })
        break
      }
    }
    if (failure !== undefined) throw failure
    if (listenerError !== undefined) throw listenerError
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
  /** Rethrows (once) an error raised inside a Playwright event listener during this step. */
  throwListenerError: () => void
  clearListenerError: () => void
  /** Where the cursor is (CSS pixels); undefined until the first movement. */
  cursor: Point | undefined
  pacing: { cursor: CursorPacing; typing: TypingPacing }
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
  if (action.risky === true) await requireApproval(ctx, step, "risky step needs approval")
  ctx.options.onEvent?.({ kind: "step_start", step })
  await perform(ctx, action, step)
  // Settle after actions that act on the app (not after pauses and checks). The extra `settleMs`
  // pacing is a presentation choice: on camera only.
  if (!["pause", "expect", "waitFor"].includes(action.action)) {
    await guard(step, () => settle(ctx, step.phase === "steps"))
  }
  ctx.throwListenerError()
  ctx.options.onEvent?.({ kind: "step_end", step })
}

async function requireApproval(ctx: Ctx, step: StepRef, detail: string): Promise<void> {
  const approved = await guard(step, async () => (await ctx.options.approveRisky?.(step)) ?? false)
  if (!approved) throw new StepError(step, "risky-not-approved", detail)
}

/**
 * The accessible label of a control (runs in the page): only buttons, links, menu items and
 * submit-like inputs count, so clicking a row or card that merely CONTAINS a "Delete" button isn't
 * mistaken for a delete. Empty string for anything else.
 */
function controlLabel(target: Element): string {
  const CONTROLS =
    "button, a, input[type=submit], input[type=button], input[type=reset], input[type=image], [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=option]"
  // A click resolved to the text or icon INSIDE a button counts as clicking the button.
  const el = target.closest(CONTROLS)
  if (el === null) return ""
  // innerText is the browser's own rendered text: words across inline tags stay whole, hidden
  // content is left out, `display: contents` wrappers are kept.
  const rendered = (e: Element) => (e instanceof HTMLElement ? e.innerText : (e.textContent ?? ""))
  const nested = [...el.querySelectorAll(CONTROLS)].filter((n) => !n.contains(el))
  // The control's OWN text: its text minus nested controls' (clicking a link card's title must not
  // be judged by a "Delete" button inside the card).
  let own = rendered(el)
  for (const n of nested) own = own.replace(rendered(n), " ")
  // Content of its own that isn't text (a thumbnail): the control isn't a mere wrapper.
  const ownMedia = [...el.querySelectorAll("img, svg, [role=img]")].some(
    (m) => !nested.some((n) => n.contains(m)),
  )
  // A wrapper with nothing of its own (<li role=menuitem><a>Delete</a></li>) is labeled by what it wraps.
  const text = own.trim() !== "" || ownMedia ? own : rendered(el)
  const isInput =
    el instanceof HTMLInputElement && ["submit", "button", "reset", "image"].includes(el.type)
  const byIds = (el.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .map((id) => (id === "" ? "" : (document.getElementById(id)?.textContent ?? "")))
    .join(" ")
  const candidates = [
    el.getAttribute("aria-label"),
    byIds,
    isInput ? el.value : null,
    text,
    el.getAttribute("title"),
  ]
  return (candidates.find((c) => c !== null && c.trim() !== "") ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
}

/**
 * Obvious risky actions, detected from the clicked element's label even without `risky: true`
 * (docs/OBJECT-MODEL.md §2b). `risky: false` on the step is an explicit opt-out.
 */
const RISKY_LABEL =
  /\b(delete|remove|destroy|erase|drop|revoke|cancel subscription|send|submit payment|pay|purchase|buy|checkout|transfer|invite|publish|deploy)\b/i

/** Upper bound of each settle wait: pages with constant activity (animations, polling) never block. */
const SETTLE_MAX_MS = 3000

/**
 * After an action, wait for the app to settle (docs/OBJECT-MODEL.md §2b): no request in flight and
 * no DOM mutation for a short quiet period, then the project's extra `settleMs`. Each wait is
 * bounded and never fails the step.
 */
async function settle(ctx: Ctx, onCamera: boolean): Promise<void> {
  // Network and DOM are independent: wait for both at once, so the worst case is one cap.
  await Promise.all([ctx.network.waitForIdle(SETTLE_MAX_MS, 200), domQuiet(ctx)])
  if (onCamera && ctx.settleMs > 0) await ctx.page.waitForTimeout(ctx.settleMs)
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
      if (action.risky === undefined) {
        const label = await guard(step, () =>
          target.evaluate(controlLabel, undefined, { timeout: ctx.timeoutMs }),
        )
        if (RISKY_LABEL.test(label)) {
          await requireApproval(
            ctx,
            step,
            `"${label}" looks risky: approve it, or set \`risky: false\` if it's safe`,
          )
        }
      }
      const aim = await moveCursorTo(ctx, target, step)
      await guard(step, async () => {
        const clicks = action.count ?? 1
        try {
          if (aim !== undefined) {
            // One press/release pair per click (a double click shows two ripples); the last
            // release is sent after the click, in `finally`.
            for (let i = 0; i < clicks; i++) {
              ctx.options.onEvent?.({ kind: "cursor", step, ...aim.point, pressed: true })
              if (i < clicks - 1)
                ctx.options.onEvent?.({ kind: "cursor", step, ...aim.point, pressed: false })
            }
          }
          await target.click({
            timeout: ctx.timeoutMs,
            // The click lands exactly where the cursor stopped: no visible jump.
            ...(aim !== undefined && { position: aim.offset }),
            ...(action.button !== undefined && { button: action.button }),
            ...(action.count !== undefined && { clickCount: action.count }),
            ...(action.modifiers !== undefined && {
              modifiers: action.modifiers.map(toPlaywrightModifier),
            }),
          })
        } finally {
          // Always release, even if the click failed: the recorder must never see a held cursor.
          if (aim !== undefined)
            ctx.options.onEvent?.({ kind: "cursor", step, ...aim.point, pressed: false })
        }
      })
      return
    }
    case "type": {
      const target = await find(ctx, action.target, step)
      const secret = secretRefName(action.value)
      assertSecretOrigin(ctx, secret, step)
      const text = secret === undefined ? action.value : await resolveSecret(ctx, secret, step)
      if (step.phase === "steps") await moveCursorTo(ctx, target, step)
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
): Promise<CursorTarget | undefined> {
  return guard(step, async () => {
    const viewport =
      ctx.page.viewportSize() ??
      (await ctx.page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    const pacing = step.phase === "steps" ? ctx.pacing.cursor : "instant"
    const random = seededRandom(`${seedOf(step)}:cursor`)
    // No box (display: contents, re-rendering…): skip the visual movement, the action still runs.
    const box = await target.boundingBox({ timeout: ctx.timeoutMs })
    const first = visiblePart(box, viewport)
    if (box === null || first === undefined) return undefined
    const to = clickPoint(first, random)
    await travel(
      ctx,
      step,
      planPath(ctx.cursor ?? center(viewport), to, {
        pacing,
        targetWidth: first.width,
        viewport,
        random,
      }),
    )
    if (pacing === "instant") {
      const at = ctx.cursor ?? to
      return { point: at, offset: await clickOffset(target, box, at, ctx.timeoutMs) }
    }
    // The target may have moved during the travel (menu sliding in, layout shift on hover): keep
    // the same relative spot on its new box, with a short correction move if needed.
    const nowBox = await target.boundingBox({ timeout: ctx.timeoutMs })
    const now = visiblePart(nowBox, viewport)
    if (nowBox === null || now === undefined) return undefined
    const point = {
      x: now.x + ((to.x - first.x) / first.width) * now.width,
      y: now.y + ((to.y - first.y) / first.height) * now.height,
    }
    if (Math.hypot(point.x - to.x, point.y - to.y) > 2) {
      await travel(
        ctx,
        step,
        planPath(ctx.cursor ?? to, point, {
          pacing: "fast",
          targetWidth: now.width,
          viewport,
          random,
        }),
      )
    }
    const at = ctx.cursor ?? point
    // Playwright's click position is relative to the element's REAL box, not its visible part.
    return { point: at, offset: await clickOffset(target, nowBox, at, ctx.timeoutMs) }
  })
}

/**
 * The click `position` for a point on screen. Playwright measures it from the element's padding
 * box (it adds the border), so the border width is subtracted: the click lands exactly on `at`.
 */
async function clickOffset(
  target: Locator,
  box: { x: number; y: number },
  at: Point,
  timeout: number,
): Promise<Point> {
  const border = await target
    .evaluate(
      (el) => {
        const style = getComputedStyle(el)
        return {
          left: parseFloat(style.borderLeftWidth) || 0,
          top: parseFloat(style.borderTopWidth) || 0,
        }
      },
      undefined,
      { timeout },
    )
    .catch(() => ({ left: 0, top: 0 }))
  return { x: at.x - box.x - border.left, y: at.y - box.y - border.top }
}

/** Where the cursor stopped, and its offset inside the target's box (for a click at that spot). */
interface CursorTarget {
  point: Point
  offset: Point
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
async function travel(ctx: Ctx, step: StepRef, path: { t: number; x: number; y: number }[]) {
  const start = Date.now()
  for (const sample of path) {
    const wait = start + sample.t - Date.now()
    if (wait > 0) await sleep(wait)
    await ctx.page.mouse.move(sample.x, sample.y)
    ctx.options.onEvent?.({ kind: "cursor", step, x: sample.x, y: sample.y, pressed: false })
  }
  const end = path.at(-1)
  if (end !== undefined) ctx.cursor = { x: end.x, y: end.y }
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
  return modKey(m) as "Alt" | "Control" | "Meta" | "Shift" | "ControlOrMeta"
}

function toPlaywrightKeys(keys: string): string {
  return keys.split("+").map(modKey).join("+")
}
