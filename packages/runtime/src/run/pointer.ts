import type { Locator } from "playwright"
import { StepError, type StepRef } from "../errors.ts"
import type { At } from "@kiframe/schema"
import { type Box, clickPoint, planPath, type Point, seededRandom } from "../motion.ts"
import { pointProbe, type ProbeArgs, viewportOf } from "../targets.ts"
import { type AnyAction, type Ctx, guard, MIN_TIMEOUT_MS, seedOf, sleep } from "./context.ts"
import { handleInterrupts } from "./interrupts.ts"
import { toPlaywrightModifier } from "./keys.ts"
import { requireApproval, RISKY_LABEL } from "./risky.ts"

// The human cursor: travel to a target, click at a verified point.

/**
 * Moves the real mouse to a point inside the target along a human-like path (so hover states happen
 * in the app), reporting cursor samples. Off camera, or with `cursor: instant`, it jumps. Returns
 * the point it stopped on, where the action then happens.
 */
export async function moveCursorTo(
  ctx: Ctx,
  target: Locator,
  step: StepRef,
  { correction = false, at }: { correction?: boolean; at?: At | undefined } = {},
): Promise<Point | undefined> {
  return guard(step, async () => {
    const viewport = await viewportOf(ctx.page)
    const onCamera = step.phase === "steps" && ctx.pacing.cursor !== "instant"
    const pacing = !onCamera ? "instant" : correction ? "fast" : ctx.pacing.cursor
    const random = seededRandom(`${seedOf(step)}:cursor${correction ? ":again" : ""}`)
    const box = await target.boundingBox({ timeout: ctx.timeoutMs })
    let to: Point
    let width: number
    if (at !== undefined) {
      // The step's own point within the box (a canvas): exactly there, never a nearby one (nor the
      // center Playwright would pick without a box).
      if (box === null) {
        throw new StepError(step, "target-not-found", "the target has no box to point in yet")
      }
      to = pointIn(box, at)
      if (!onScreen(to, viewport)) {
        throw new StepError(
          step,
          "target-not-found",
          `the point at (${at.x}, ${at.y}) of the target is off screen: scroll it into view first`,
        )
      }
      width = 24
    } else {
      // No box (display: contents, re-rendering…): skip the visual movement, the action still runs.
      const visible = visiblePart(box, viewport)
      if (visible === undefined) return undefined
      to = clickPoint(visible, random)
      width = visible.width
    }
    await travel(
      ctx,
      step,
      planPath(ctx.cursor ?? center(viewport), to, {
        pacing,
        targetWidth: width,
        viewport,
        random,
      }),
    )
    return ctx.cursor
  })
}

/** Whether a point is on the viewport's pixels, [0, width-1] × [0, height-1]. */
export function onScreen(p: Point, viewport: { width: number; height: number }): boolean {
  return p.x >= 0 && p.y >= 0 && p.x <= viewport.width - 1 && p.y <= viewport.height - 1
}

/** The point `at` (fractions of the box) of a box, in CSS pixels of the viewport. */
export function pointIn(box: Box, at: At): Point {
  // 1 is the far edge's last pixel, still on the element (never the neighbour past it).
  return {
    x: box.x + Math.min(at.x * box.width, Math.max(0, box.width - 1)),
    y: box.y + Math.min(at.y * box.height, Math.max(0, box.height - 1)),
  }
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
export async function clickAtCursor(
  ctx: Ctx,
  target: Locator,
  step: StepRef,
  action: Extract<AnyAction, { action: "click" }>,
): Promise<void> {
  let point = await moveCursorTo(ctx, target, step, { at: action.at })
  let deadline = Date.now() + ctx.timeoutMs
  const left = () => Math.max(MIN_TIMEOUT_MS, deadline - Date.now())
  // A token marks the element found under the point, so a later probe can tell it's the SAME node.
  const token = `${seedOf(step)}:${Date.now()}`
  const probeAt = (p: Point) =>
    target.evaluate(pointProbe, [p.x, p.y, true, false, token] as ProbeArgs, { timeout: left() })
  await guard(step, async () => {
    let probe = point === undefined ? undefined : await probeAt(point)
    if (point !== undefined && probe !== undefined && !probe.hits) {
      // Covered at our point: an interrupt that just appeared (a modal) is handled first, off
      // camera, before any approval and before the press: nothing has happened yet. Then aim again.
      await handleInterrupts(ctx, step)
      point = (await moveCursorTo(ctx, target, step, { correction: true, at: action.at })) ?? point
      deadline = Date.now() + ctx.timeoutMs // the corrective travel doesn't count either
      probe = await probeAt(point)
      // Still covered at our point: let Playwright choose one (it reports interceptions clearly);
      // never another point when the step named its own (a canvas: another spot is another click).
      if (!probe.hits && action.at !== undefined) {
        throw new StepError(step, "action-failed", "something covers the target at that point")
      }
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
        // A named point is measured again on the box as it is now (the page may have moved while
        // the user approved): the check, the click and the take's ripple all use it.
        if (point !== undefined && action.at !== undefined) {
          const moved = await target.boundingBox({ timeout: left() }).catch(() => null)
          if (moved !== null) point = pointIn(moved, action.at)
        }
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
export function visiblePart(
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
export async function travel(
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
