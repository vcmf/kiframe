import { z } from "zod"
import { isToolSoftError, toolRejected, toolThrew, unknownTool } from "./tool-result.ts"
import { buildModelMessages, emptyResultText, type ToolMsgMeta } from "./tool-result-view.ts"
import type {
  AgentEvent,
  LlmClient,
  LlmImage,
  LlmMessage,
  LlmToolDef,
  LlmTurn,
  Tool,
} from "./types.ts"

// The agent loop (ported from cooldown): drives an `LlmClient` through tool-calling turns against
// the host's tools, yielding `AgentEvent`s. Provider-agnostic and network-free by construction.
// Kiframe's fixes over cooldown's: cancellation (AbortSignal, to the model and the tools), call ids
// on tool events, an explicit turn-limit end, the text a model writes with its tool calls kept,
// the run's messages returned structured (to store and replay as history), provider errors as an
// `error` end. Tools run one at a time: an approval a tool asks for (`requestUser` in the host's
// context) is never raced by another.

/** Tool-calling rounds per run: bounded, so a misbehaving model can't loop forever. */
export const DEFAULT_MAX_TURNS = 30

const toJsonSchema = (schema: z.ZodType): Record<string, unknown> => {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  delete json.$schema
  return json
}

const toDefs = <C>(tools: Tool<C>[]): LlmToolDef[] =>
  tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toJsonSchema(t.parameters),
  }))

/** A call's JSON arguments, tolerating malformed or non-object input. */
const parseArgs = (raw: string): Record<string, unknown> => {
  try {
    const v: unknown = JSON.parse(raw)
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** What a call that the stop prevented, or that stopped with it, answers. */
const ABORTED = { ok: false, error: "aborted", message: "the run was stopped by the user" }

/**
 * Runs one tool call and returns the model-facing result: the tool's own output, or a structured
 * failure (unknown tool, a thrown error, the tool's own `{ error }`; a tool that threw because the
 * run was stopped: `aborted`, never a crash to retry). No failure ends the run.
 */
export async function executeToolCall<C>(
  name: string,
  args: Record<string, unknown>,
  tools: Tool<C>[],
  ctx: C,
  signal: AbortSignal,
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name)
  if (tool === undefined) return unknownTool(name)
  try {
    const result = await tool.run(args, ctx, signal)
    return isToolSoftError(result) ? toolRejected(tool.name, result.error) : result
  } catch (err) {
    return signal.aborted ? ABORTED : toolThrew(tool.name, err)
  }
}

/** A tool result as the model reads it: never empty, and never an exception (a circular object). */
function serializeToolResult(output: unknown, toolName: string): string {
  try {
    const s = JSON.stringify(output)
    return s === undefined ? emptyResultText(toolName) : s
  } catch (error) {
    return JSON.stringify(
      toolThrew(toolName, new Error(`its result couldn't be read: ${errorMessage(error)}`)),
    )
  }
}

/** A tool result the UI can show (a plain value: what the model read, parsed back). */
const shownResult = (content: string): unknown => {
  try {
    return JSON.parse(content) as unknown
  } catch {
    return content
  }
}

/** Whether a call's streamed arguments are whole JSON (a turn cut off by a length limit isn't). */
const wholeJson = (raw: string): boolean => {
  if (raw.trim() === "") return true
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

export type RunAgentOptions<C> = {
  userMessage: string
  tools: Tool<C>[]
  llm: LlmClient
  /** The host's context for the tools (the project, the browser, `requestUser`…), passed as is. */
  context: C
  system?: string
  /** Prior turns, structured (a previous run's `messages`), so the agent remembers the chat. */
  history?: LlmMessage[]
  /** Images attached to this turn's user message (never stored in history). */
  images?: LlmImage[]
  maxTurns?: number
  /** Cancels the run: the model call and the running tool get it; the run ends `aborted`. */
  signal?: AbortSignal
}

/** Runs the agent, yielding events as the answer streams and tools run. */
export async function* runAgent<C>(opts: RunAgentOptions<C>): AsyncGenerator<AgentEvent> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const signal = opts.signal ?? new AbortController().signal
  const defs = toDefs(opts.tools)
  const prior: LlmMessage[] = []
  if (opts.system !== undefined) prior.push({ role: "system", content: opts.system })
  if (opts.history !== undefined) prior.push(...opts.history)
  // What this run adds (returned at its end): the user message, then every turn.
  const added: LlmMessage[] = [{ role: "user", content: opts.userMessage }]
  // Images are sent with this turn only (the stored message has none).
  const live: LlmMessage = {
    role: "user",
    content: opts.userMessage,
    ...(opts.images !== undefined && opts.images.length > 0 && { images: opts.images }),
  }
  const keepFullNames = new Set(opts.tools.filter((t) => t.keepFullResult).map((t) => t.name))
  const metaOf = (m: Extract<LlmMessage, { role: "tool" }>): ToolMsgMeta => ({
    toolName: m.toolName ?? "tool",
    keepFull: keepFullNames.has(m.toolName ?? ""),
  })
  // History's results were shown in their own runs: old bulky ones are elided by recency.
  const shownBulky = new Set<string>(
    prior.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])),
  )
  let calls = 0

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (signal.aborted) {
      yield { type: "aborted", messages: added }
      return
    }
    const log = [...prior, live, ...added.slice(1)]
    const modelMessages = buildModelMessages(log, metaOf, shownBulky)
    let result: LlmTurn
    try {
      result = yield* modelTurn(opts.llm, modelMessages, defs, signal)
    } catch (error) {
      if (signal.aborted) {
        yield { type: "aborted", messages: added }
        return
      }
      yield { type: "error", message: errorMessage(error), messages: added }
      return
    }
    const details =
      result.reasoningDetails !== undefined ? { reasoningDetails: result.reasoningDetails } : {}
    if (result.kind === "text") {
      added.push({ role: "assistant", content: result.text, ...details })
      yield { type: "assistant_text", text: result.text }
      yield { type: "done", messages: added }
      return
    }
    // Every call has an id (a provider may send none: pairing and the wire need one), and whole
    // JSON arguments (a cut-off call is stored as {} and never run: the model is told).
    const turnCalls = result.calls.map((c) => ({
      ...c,
      id: c.id === "" ? `call-${(calls += 1)}` : c.id,
      cut: !wholeJson(c.arguments),
    }))
    added.push({
      role: "assistant",
      content: result.text ?? "",
      toolCalls: turnCalls.map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.cut ? "{}" : c.arguments,
      })),
      ...details,
    })
    for (const call of turnCalls) {
      // Every call gets a result (the history stays well-formed); the UI sees the ones that
      // started, with their results.
      if (signal.aborted) {
        added.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify(ABORTED),
        })
        continue
      }
      const args = call.cut ? {} : parseArgs(call.arguments)
      yield { type: "tool_start", callId: call.id, toolName: call.name, args }
      let output: unknown
      if (call.cut) {
        output = toolRejected(
          call.name,
          "your arguments were cut off (not whole JSON: the reply hit its length limit): make the call again, shorter",
        )
      } else if (signal.aborted) {
        // Stopped while its start was being shown: not run.
        output = ABORTED
      } else {
        output = await executeToolCall(call.name, args, opts.tools, opts.context, signal)
      }
      const content = serializeToolResult(output, call.name)
      yield {
        type: "tool_result",
        callId: call.id,
        toolName: call.name,
        result: shownResult(content),
      }
      added.push({ role: "tool", toolCallId: call.id, toolName: call.name, content })
    }
  }
  if (signal.aborted) {
    yield { type: "aborted", messages: added }
    return
  }
  yield { type: "turn_limit", maxTurns, messages: added }
}

/** One model turn, streamed when the client can: text, reasoning and pending calls as they come. */
async function* modelTurn(
  llm: LlmClient,
  messages: LlmMessage[],
  defs: LlmToolDef[],
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, LlmTurn> {
  if (llm.completeStream === undefined) {
    const turn = await llm.complete(messages, defs, signal)
    // The text a model writes with its tool calls is shown (a final text is, by the caller).
    if (turn.kind === "tool_calls" && turn.text !== undefined && turn.text !== "") {
      yield { type: "assistant_text", text: turn.text }
    }
    return turn
  }
  let text = ""
  let reasoning = ""
  let final: LlmTurn | undefined
  for await (const ev of llm.completeStream(messages, defs, signal)) {
    if (ev.kind === "delta") {
      text += ev.text
      yield { type: "assistant_text", text }
    } else if (ev.kind === "reasoning") {
      reasoning += ev.text
      yield { type: "reasoning", text: reasoning }
    } else if (ev.kind === "tool_start") {
      yield { type: "tool_pending", toolName: ev.name }
    } else {
      final = ev.turn
    }
  }
  return final ?? { kind: "text", text }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
