import type { Page } from "playwright"
import { StepError, type StepRef } from "../errors.ts"
import { type Ctx, firstLine, guard } from "./context.ts"
import { applyHide } from "./interrupts.ts"
import {
  followSecretFields,
  followSecretText,
  leaveSecretFields,
  leaveSecretText,
  pathOnly,
  scrubSecrets,
} from "./secrets.ts"
import { settle } from "./settle.ts"
import { now } from "../clock.ts"

// Following tabs and popups: the page the run drives, and switching to it.

/** Drives `next` from now on: listeners, network tracking, the recorder's capture follow it. */
export async function switchPage(ctx: Ctx, next: Page, step: StepRef): Promise<void> {
  ctx.switching = true
  try {
    await switchTo(ctx, next, step)
  } finally {
    ctx.switching = false
  }
}

async function switchTo(ctx: Ctx, next: Page, step: StepRef): Promise<void> {
  // Reads already running finish on the page they started on (the tick starts none mid-switch).
  await ctx.fieldsInflight?.catch(() => undefined)
  await ctx.secretText.inflight?.catch(() => undefined)
  // The page the capture leaves, and since when it was shown (its last read comes right before the
  // capture switches).
  const leaving = { page: ctx.page, shown: ctx.pageShownAt }
  ctx.detach(ctx.page)
  // Headed and CDP runs: the driven page is the visible tab (a background tab is throttled).
  await next.bringToFront().catch(() => undefined)
  // The real mouse is per page: each page keeps where the cursor was on it.
  if (ctx.cursor !== undefined) ctx.cursors.set(ctx.page, ctx.cursor)
  ctx.page = next
  ctx.network = ctx.trackerOf(next)
  ctx.attach(next)
  await applyHide(ctx, next)
  ctx.cursor = ctx.cursors.get(next)
  // This page's secret fields are measured BEFORE the capture moves here (its first frame is
  // already covered); the other pages' blurs end only AFTER the capture left them. A field back on
  // this page is on screen from now, whenever it's measured.
  ctx.pageShownAt = now()
  if (ctx.options.recording === true) await followSecretFields(ctx, step)
  // A last read of the page the capture is about to leave, as late as it can be: after everything
  // done for the next page (its focus, which blurs this one, hide rules, its own read), right before
  // the capture switches (T2). A move since its last tick is covered; its text scan stays before
  // the switch (the next page's text is dated from it, floored at that page's switch). A closed page
  // can't be read: its last boxes stay until left.
  if (ctx.options.recording === true && !leaving.page.isClosed()) {
    await Promise.all([
      followSecretFields(ctx, step, leaving),
      followSecretText(ctx, step, true, leaving),
    ])
  }
  try {
    await guard(step, async () => ctx.options.onPageSwitch?.(next))
  } finally {
    // Its regions are left (T4: until the next page's first frame), even if the capture failed to
    // switch (never left open on a page no longer driven).
    if (ctx.options.recording === true) {
      leaveSecretFields(ctx, step)
      leaveSecretText(ctx, step)
    }
  }
  ctx.options.onEvent?.({
    kind: "navigate",
    step,
    url: scrubSecrets(pathOnly(next.url()), ctx.secretValues),
  })
}

/**
 * Brings the driven page in line with the browser, at a step boundary (the one place pages change):
 * 1. the driven page closed (a popup's "Done", an OAuth window): back to the nearest open opener;
 * 2. the LAST page opened, if it's still open once loaded, is driven from now on (and settled). If
 *    it closed already, the run stays where it is: an earlier tab is never picked instead.
 */
export async function syncPage(ctx: Ctx, step: StepRef): Promise<void> {
  if (ctx.page.isClosed()) {
    let back = ctx.openers.pop()
    while (back?.isClosed() === true) back = ctx.openers.pop()
    // "Continue in a new window": the page opened a tab and closed itself.
    back ??= ctx.opened.filter((p) => !p.isClosed()).at(-1)
    if (back !== undefined) ctx.opened.splice(0)
    if (back === undefined) {
      throw new StepError(
        step,
        "page-closed",
        "the page was closed and there's no page to return to",
      )
    }
    await switchPage(ctx, back, step)
    // The opener reacts (an OAuth callback loads the app): settled before going on.
    await guard(step, () => settle(ctx, step.phase === "steps"))
  }
  const next = ctx.opened.splice(0).at(-1)
  if (next === undefined || next.isClosed()) return
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
