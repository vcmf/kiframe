import { StepError, type StepRef } from "../errors.ts"
import { type Ctx, guard } from "./context.ts"

// A handover step (off camera: a setup's, a preset's): the user takes the browser for a moment (a
// code at sign-in, a CAPTCHA). The run waits for them; an unattended one can't do one.

/** What the host is asked (the page the user acts on: the run's own). */
export interface HandoverRequest {
  step: StepRef
  task: string
  doneWhen?: string
  page: import("playwright").Page
}

export async function handover(
  ctx: Ctx,
  action: { task: string; done_when?: string | undefined },
  step: StepRef,
): Promise<void> {
  const ask = ctx.options.requestHandover
  if (ask === undefined) {
    throw new StepError(
      step,
      "needs-user",
      "a handover needs the user: run this scene from the app (an unattended run can't do one)",
    )
  }
  // The capture stops first (a recording: nothing the user does is written); it starts again after
  // the step's own end scans (`runOne`).
  ctx.handingOver = true
  await guard(step, async () => ctx.options.onHandover?.("start", ctx.page))
  const answer = await guard(step, () =>
    ask({
      step,
      task: action.task,
      ...(action.done_when !== undefined && { doneWhen: action.done_when }),
      page: ctx.page,
    }),
  )
  // The user's hands moved the pointer: the next move starts afresh, never from where it was.
  ctx.cursor = undefined
  ctx.cursors.clear()
  if (answer.outcome !== "done") {
    // Their note: why (the agent asks them again knowing it).
    const why = answer.note?.trim() ?? ""
    throw new StepError(
      step,
      "handover-declined",
      `the user couldn't do the handover's task${why === "" ? "" : `: "${why.slice(0, 300)}"`}`,
    )
  }
}
