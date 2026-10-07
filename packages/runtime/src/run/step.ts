import { StepError, type StepRef } from "../errors.ts"
import { perform } from "./actions.ts"
import { type AnyAction, type Ctx, guard } from "./context.ts"
import { handleInterrupts } from "./interrupts.ts"
import { syncPage } from "./pages.ts"
import { confine } from "./apps.ts"
import { requireApproval } from "./risky.ts"
import { followSecretFields, followSecretText } from "./secrets.ts"
import { settle } from "./settle.ts"

// One step's lifecycle: follow the page, handle interrupts, approval, the action, settle.

/**
 * Runs one action. Every failure, including from callbacks, is a StepError naming this step.
 * `app`: the app it means when it names none (`run/apps.ts`), given by its caller.
 */
export async function runOne(
  ctx: Ctx,
  action: AnyAction,
  step: StepRef,
  app: string,
): Promise<void> {
  ctx.app = app
  // Stopped: no later step, of any kind (a cleanup neither).
  if (ctx.options.signal?.aborted === true) {
    throw new StepError(step, "stopped", "the run was stopped")
  }
  ctx.setCurrent(step)
  // Before step_start: the step's storyboard shot (taken at step_start) is of the page it acts on.
  await syncPage(ctx, step)
  // Cookie banners, "What's new" modals…: handled off camera between steps (cut from the video).
  // Not before a navigation: the page it would clear is about to be replaced.
  if (action.action !== "goto") await handleInterrupts(ctx, step)
  if (action.risky === true) await requireApproval(ctx, step, "risky step needs approval")
  ctx.options.onEvent?.({ kind: "step_start", step })
  const on = ctx.page
  try {
    await perform(ctx, action, step)
  } catch (error) {
    // The action closed its own page (a "Done" button calling window.close()): Playwright can end
    // the click with "Target page … has been closed" as the close lands. It did what it should:
    // syncPage goes back to the opener (or says there's none).
    if (!on.isClosed()) throw error
  }
  // Settle after actions that act on the app (not after pauses and checks). The extra `settleMs`
  // pacing is a presentation choice: on camera only. A page the action closed has nothing to settle.
  if (!["pause", "expect", "waitFor"].includes(action.action)) {
    await guard(step, () => settle(ctx, step.phase === "steps"))
  }
  await syncPage(ctx, step)
  // Where the step ended (the page it left driven: a popup, the opener back): one of the apps.
  if (ctx.options.confineToApps !== false) await confine(ctx, step)
  if (ctx.options.recording === true) {
    await followSecretFields(ctx, step)
    // The page as the step left it: not a scan that started earlier in the step.
    await followSecretText(ctx, step, true)
  }
  ctx.throwListenerError()
  ctx.options.onEvent?.({ kind: "step_end", step })
}
