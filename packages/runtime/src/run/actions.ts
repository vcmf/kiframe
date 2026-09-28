import { isGrounded, secretRefName, type Target } from "@kiframe/schema"
import type { ElementHandle, FileChooser, Locator } from "playwright"
import { StepError, type StepRef } from "../errors.ts"
import { EXACT_NAMES_HINT } from "../secret-state.ts"
import {
  type Box,
  clickPoint,
  planPath,
  type Point,
  seededRandom,
  typingDelays,
} from "../motion.ts"
import { isOnScreen, locatorFor, resolveTarget, stripExtras, viewportOf } from "../targets.ts"
import { waitForCondition } from "./conditions.ts"
import {
  type AnyAction,
  type Ctx,
  guard,
  MIN_TIMEOUT_MS,
  seedOf,
  sleep,
  timeoutOf,
} from "./context.ts"
import { hasFocus, moveCaretToEnd, toPlaywrightKeys } from "./keys.ts"
import { clickAtCursor, moveCursorTo, travel, visiblePart } from "./pointer.ts"
import { explainOffScreen } from "./risky.ts"
import {
  abandonSecretWrite,
  assertSecretTarget,
  assertDragKeepsSecrets,
  assertKeysKeepSecrets,
  assertSecretOrigin,
  followSecretField,
  prepareSecretWrite,
  type SecretWrite,
  writeSecret,
} from "./secrets.ts"

// The actions: `perform` dispatches each step to its implementation (type, drag, upload, scroll…).

export async function perform(ctx: Ctx, action: AnyAction, step: StepRef): Promise<void> {
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
      const secret = secretRefName(action.value)
      // Before anything touches the page (`find`, `clear`): a secret step's target is one exact
      // locator (the schema says so; a scenario built in code skips the schema).
      if (secret !== undefined) assertSecretTarget(action.target, step, secret)
      const target = await find(ctx, action.target, step)
      assertSecretOrigin(ctx, secret, step)
      // A secret is resolved at the last moment, once the field it goes into is focused.
      const text = secret === undefined ? action.value : ""
      let secretWrite: SecretWrite | undefined
      const sensitiveId =
        secret === undefined ? undefined : followSecretField(ctx, step, secret, target)
      if (step.phase === "steps") await moveCursorTo(ctx, target, step)
      let fieldBox: Box | null = null
      try {
        await guard(step, async () => {
          const timeout = ctx.timeoutMs
          // Same semantics on and off camera: the text is added at the end of the field's content,
          // unless `clear` empties the field first.
          if (action.clear === true) await target.fill("", { timeout })
          await target.focus({ timeout })
          // The text goes to the focused element: make sure it's the target, never the field focused
          // before (a secret would land there, on camera).
          if (!(await target.evaluate(hasFocus, undefined, { timeout }))) {
            throw new StepError(
              step,
              "action-failed",
              "target can't take keyboard focus (use a locator for the input itself)",
            )
          }
          await target.evaluate(moveCaretToEnd, undefined, { timeout })
          if (secret !== undefined) {
            secretWrite = await prepareSecretWrite(ctx, target, step, secret, action.target)
          }
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
          if (secretWrite !== undefined) {
            await writeSecret(ctx, secretWrite, step, timeout)
          } else if (action.instant === true) {
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
      } catch (error) {
        // A prepared write the step never made (it failed in between): its handle is released.
        const written = secretWrite
        if (written !== undefined && !ctx.secretWritten.some((w) => w.handle === written.input)) {
          await abandonSecretWrite(written)
        }
        throw error
      }
      // End of typing (before the submit, which may navigate or re-lay out the page).
      ctx.options.onEvent?.({ kind: "type", step, secret, box: fieldBox ?? undefined })
      if (action.submit === true) {
        await guard(step, () => target.press("Enter", { timeout: ctx.timeoutMs }))
        ctx.options.onEvent?.({ kind: "key", step, keys: "Enter" })
      }
      return
    }
    case "press":
      await assertKeysKeepSecrets(ctx, step, action.keys)
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
  await assertDragKeepsSecrets(ctx, step, source)
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
  const candidates = (await locatorFor(ctx.page, stripExtras(target))).and(
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
  const hidden = await guard(step, () => hiddenFileInput(ctx, action.target))
  if (hidden !== undefined) {
    await guard(step, () => hidden.setInputFiles(file, { timeout: ctx.timeoutMs }))
    return
  }
  let target: Locator
  try {
    target = await find(ctx, action.target, step)
  } catch (error) {
    // Nothing visible: the hidden input may have rendered late (checked once more now).
    // A refusal there (§3 A8) mustn't hide the real error.
    const late = await hiddenFileInput(ctx, action.target).catch(() => undefined)
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
    // An upload isn't a risky action by itself (a dropzone says "drop"): only `risky: true` gates it.
    await explainOffScreen(ctx, target, step, () =>
      clickAtCursor(ctx, target, step, {
        action: "click",
        target: action.target,
        risky: action.risky ?? false,
      }),
    )
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

async function find(ctx: Ctx, target: Target, step: StepRef): Promise<Locator> {
  const result = await guard(step, () => resolveTarget(ctx.page, target, ctx.timeoutMs))
  if (!result.ok) {
    // Names are exact while a field holding a secret is on the page (§3 A8): say so.
    const exact = result.exact && result.reason === "target-not-found"
    const hint = exact ? EXACT_NAMES_HINT : ""
    throw new StepError(step, result.reason, result.detail + hint)
  }
  if (result.fallbackIndex !== undefined) {
    ctx.options.onEvent?.({ kind: "target_fallback", step, fallbackIndex: result.fallbackIndex })
  }
  // Auto-scroll into view (smooth, human-like scrolling comes with P0-4).
  await guard(step, () => result.locator.scrollIntoViewIfNeeded({ timeout: ctx.timeoutMs }))
  return result.locator
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
  // Whether names were exact at the last poll (§3 A8): the errors say so.
  let exact = false
  const hint = () => (exact ? EXACT_NAMES_HINT : "")
  for (;;) {
    const left = deadline - Date.now()
    if (left <= 0) {
      throw new StepError(
        step,
        "target-not-found",
        `target not on screen after scrolling for ${ctx.timeoutMs} ms${hint()}`,
      )
    }
    // One polling round per page (no waiting): the scroll itself is what makes the target appear.
    const result = await guard(step, () => resolveTarget(ctx.page, until, 0))
    exact = result.exact
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
        `scrolled until the end, target never appeared on screen${hint()}`,
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
