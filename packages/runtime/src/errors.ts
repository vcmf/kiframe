/** Where in the scenario something happened. */
export interface StepRef {
  phase: "setup" | "steps" | "teardown"
  /** Index in the phase's list (after preset expansion for setup). */
  index: number
  stepId?: string | undefined
  action: string
}

export type StepErrorReason =
  | "not-grounded"
  | "target-not-found"
  | "target-ambiguous"
  | "condition-timeout"
  | "expectation-failed"
  | "off-origin"
  | "risky-not-approved"
  | "secret-unavailable"
  | "action-failed"
  | "invalid-setup"

/**
 * A step failed. The message says which step and why, in words a user (or the agent) can act on:
 * "steps[2] (name-project, type): target not found — label "Project name"".
 */
export class StepError extends Error {
  readonly step: StepRef
  readonly reason: StepErrorReason
  /** The message without the "where" prefix. */
  readonly detail: string

  constructor(
    step: StepRef,
    reason: StepErrorReason,
    detail: string,
    options?: { cause?: unknown },
  ) {
    const where = `${step.phase}[${step.index}]${step.stepId ? ` (${step.stepId}, ${step.action})` : ` (${step.action})`}`
    super(`${where}: ${detail}`, options)
    this.name = "StepError"
    this.step = step
    this.reason = reason
    this.detail = detail
  }
}
