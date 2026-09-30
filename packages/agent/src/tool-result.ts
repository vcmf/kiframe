/**
 * Uniform result contract for a single tool call in the agent loop (ported from cooldown).
 *
 * A successful call returns the tool's own output verbatim. A failure (an unknown tool, a thrown
 * error, a tool's own rejection) is shaped here into a structured, model-directed object instead
 * of a terse string: `error` is a stable machine code (for the UI), `message` the guidance the
 * model reads, so it understands what happened and what to do next.
 */

/**
 * Failure codes, by origin: `user_declined` (confirm gate), `unknown_tool` (no
 * such tool), `tool_error` (the tool THREW — a crash, may be transient), and
 * `tool_rejected` (the tool RAN and returned `{error}` — a deliberate rejection
 * like bad args / not found).
 */
export type ToolErrorCode =
  "user_declined" | "unknown_tool" | "tool_error" | "tool_rejected" | "aborted"

/** A structured tool-call failure fed back to the model as the tool result. */
export type ToolFailure = {
  ok: false
  error: ToolErrorCode
  tool: string
  message: string
}

/** True when a tool result is a structured failure (vs a tool's own output). */
export const isToolFailure = (result: unknown): result is ToolFailure =>
  typeof result === "object" &&
  result !== null &&
  (result as { ok?: unknown }).ok === false &&
  typeof (result as { message?: unknown }).message === "string"

/**
 * The failure convention for tool authors: a tool signals a rejection (bad
 * args, not found, validation) by returning `{ error: string }`. Detected here
 * so `executeToolCall` can normalize it into a `ToolFailure` — keeping tools
 * simple while the runtime/UI get one uniform failure shape. Not matched once a
 * result is already a `ToolFailure` (has `ok`).
 */
export const isToolSoftError = (result: unknown): result is { error: string } =>
  typeof result === "object" &&
  result !== null &&
  !("ok" in result) &&
  typeof (result as { error?: unknown }).error === "string" &&
  (result as { error: string }).error.length > 0

/** Normalize a tool's own `{ error }` rejection into the shared failure shape. */
export const toolRejected = (tool: string, message: string): ToolFailure => ({
  ok: false,
  error: "tool_rejected",
  tool,
  message,
})

/**
 * The user declined what this tool call asked for (an approval it requested): a permission choice,
 * not a failure. A genuinely different call may still be allowed.
 */
export const userDeclined = (tool: string): ToolFailure => ({
  ok: false,
  error: "user_declined",
  tool,
  message:
    `The user declined this "${tool}" request — a permission choice, not a failure ` +
    `or a transient error. Don't repeat this exact call. A genuinely different ` +
    `"${tool}" request may still be allowed if the task needs it; otherwise ` +
    `continue with what you already have and, if it matters, tell the user this ` +
    `request wasn't approved.`,
})

/** The model called a tool that isn't in this run's toolset. */
export const unknownTool = (tool: string): ToolFailure => ({
  ok: false,
  error: "unknown_tool",
  tool,
  message:
    `There is no tool named "${tool}". Only call tools that were provided to you. ` +
    `Pick a valid tool for this step, or answer directly if none applies.`,
})

/** A tool threw while running (e.g. a managed service 500 or a network error). */
export const toolThrew = (tool: string, err: unknown): ToolFailure => ({
  ok: false,
  error: "tool_error",
  tool,
  message:
    `The "${tool}" tool failed with an error: ${err instanceof Error ? err.message : String(err)}. ` +
    `You may retry once if this looks transient; otherwise continue without it and ` +
    `tell the user what could not be completed.`,
})

/** The user stopped the run before or while this call ran: not a failure of the tool. */
export const toolAborted = (tool: string): ToolFailure => ({
  ok: false,
  error: "aborted",
  tool,
  message:
    `The user stopped the run before "${tool}" finished: it may not have run, or only in part. ` +
    `Don't assume its effect; check the current state before relying on it.`,
})

/** The run ended (an error) before this call ran: it didn't run. */
export const toolNotRun = (tool: string, reason: string): ToolFailure => ({
  ok: false,
  error: "aborted",
  tool,
  message: `"${tool}" didn't run: the run ended first (${reason}). Call it again if it's still needed.`,
})

/** What a reply the provider cut short (or failed mid-way) is: never a complete turn. */
export const CUT_SHORT = "the model's reply ended before it was complete"
