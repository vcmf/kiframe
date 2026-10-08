/** Where in the scenario something happened. */
export interface StepRef {
  phase: "setup" | "steps"
  /** Index in the phase's list (after preset expansion for setup). */
  index: number
  stepId?: string | undefined
  action: string
  /** Set on the action of an interrupt rule's `do`, run within this step (the rule's id). */
  interrupt?: string | undefined
  /** The preset this action comes from (its secret approvals are the preset's, §3 A1). */
  preset?: string | undefined
}

export type StepErrorReason =
  | "not-grounded"
  | "target-not-found"
  | "target-ambiguous"
  | "condition-timeout"
  | "expectation-failed"
  | "off-origin"
  | "risky-not-approved"
  /** A handover step in a run no one can answer (unattended): it needs the user. */
  | "needs-user"
  /** The user couldn't do a handover's task. */
  | "handover-declined"
  /** A reused session (a session preset's saved state) failed its check: signed out, expired. */
  | "session-expired"
  | "secret-unavailable"
  | "secret-refused"
  /** The user declined the approval of a secret step: the scene is `blocked` (§3 A3). */
  | "secret-declined"
  | "action-failed"
  | "invalid-setup"
  /** A step ended on a page that isn't one of the project's apps (OBJECT-MODEL §0.9). */
  | "off-app"
  /** The run's signal was aborted (the user stopped it): nothing more ran. */
  | "stopped"
  /**
   * A step closed the page it ran on and the run knows no page to return to (a popup a new run
   * started on: the host's own opener may still be open).
   */
  | "page-closed"

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

/** Where and into what a secret is about to be typed: what the resolver (the vault) checks. */
export interface SecretUse {
  /** The host's id of the project (or org) the approvals belong to. */
  scope: string
  /** Which step types it (SECRETS-DESIGN §3 A1): `scene:…`, `preset:…`, `interrupt:…`, `org:…`. */
  stepKey: string
  /** The page's origin and pathname. */
  origin: string
  path: string
  /** `canonicalTarget` of the step's target. */
  target: string
  /** The element the value goes into. */
  element: { tag: "input" | "textarea"; type: string; label: string | null }
}

/**
 * A resolver's refusal (the vault's `SecretRefusal`): any error with `code: "secret-refused"`, not
 * `instanceof` (duplicate modules). Over IPC the host must rethrow it with its `code` and `reason`
 * (Electron drops custom properties; without `reason: "no-grant"` an interactive run can't ask).
 * Its message is reported, so it must never hold a value.
 */
export function isSecretRefusal(error: unknown): error is Error & { reason?: string } {
  return error instanceof Error && (error as { code?: unknown }).code === "secret-refused"
}

/** What an interactive run asks the user when a use has no grant yet (§3 A3). */
export interface ApprovalRequest {
  secret: string
  use: SecretUse
  /** The element's box on the page (CSS pixels): what the prompt outlines. */
  box?: { x: number; y: number; width: number; height: number } | undefined
  /**
   * The page as it is (a JPEG, base64, of the viewport, `width`×`height` CSS pixels), the element in
   * view (the step brought it there): the prompt shows it outlined (§3 A3: built from the live page).
   * Taken before the value is typed; the user's own screen, for their prompt only (never the
   * agent, a take or a file).
   */
  shot?: { jpeg: string; width: number; height: number } | undefined
}
