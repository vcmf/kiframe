import type { Locator } from "playwright"
import { StepError, type StepRef } from "../errors.ts"
import { viewportOf } from "../targets.ts"
import { type Ctx, guard } from "./context.ts"

// Risky actions: approvals, the label check, and the off-screen diagnosis of failed pointer actions.

/** Playwright's own "Timeout …ms exceeded" on an action (nothing else is): a StepError's detail. */
export function isActionTimeout(error: StepError): boolean {
  return /Timeout \d+ms exceeded/.test(error.detail)
}

export async function requireApproval(ctx: Ctx, step: StepRef, detail: string): Promise<void> {
  const approved = await guard(step, async () => (await ctx.options.approveRisky?.(step)) ?? false)
  if (!approved) throw new StepError(step, "risky-not-approved", detail)
}

/**
 * Obvious risky actions, detected from the clicked element's label even without `risky: true`
 * (docs/OBJECT-MODEL.md §2b). `risky: false` on the step is an explicit opt-out.
 */
export const RISKY_LABEL =
  /\b(delete|remove|trash|destroy|erase|drop|revoke|cancel subscription|send|submit payment|pay|purchase|buy|checkout|transfer|invite|publish|deploy)\b/i

/**
 * Runs a pointer action; if it fails on a target that is off screen (entirely outside the viewport,
 * after `find` scrolled it: a collapsed sidebar or drawer), the error says so instead of a bare
 * timeout. Diagnosis only: nothing changes for an action that succeeds.
 */
export async function explainOffScreen(
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
      // An interrupt rule's failure inside this step is about that rule, not this target.
      error.step.interrupt !== step.interrupt ||
      !isActionTimeout(error)
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
