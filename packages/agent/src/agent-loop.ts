import { z } from "zod"
import {
  isToolSoftError,
  toolAborted,
  toolRejected,
  toolThrew,
  unknownTool,
} from "./tool-result.ts"
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
    return signal.aborted
      ? toolAborted(tool.name)
      : toolThrew(tool.name, new Error(errorMessage(err)))
  }
}

/** A tool result as the model reads it: never empty, and never an exception (a circular object). */
function serializeToolResult(
  output: unknown,
  toolName: string,
): { content: string; shown: unknown } {
  try {
    const s = JSON.stringify(output)
    return s === undefined
      ? { content: emptyResultText(toolName), shown: output }
      : { content: s, shown: output }
  } catch (error) {
    const failure = toolThrew(
      toolName,
      new Error(`its result couldn't be read: ${errorMessage(error)}`),
    )
    return { content: JSON.stringify(failure), shown: failure }
  }
}

/** A call's arguments, parsed once: `whole` false when they aren't a JSON object. */
const readArgs = (raw: string): { whole: boolean; args: Record<string, unknown> } => {
  if (raw.trim() === "") return { whole: true, args: {} }
  try {
    const v: unknown = JSON.parse(raw)
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? { whole: true, args: v as Record<string, unknown> }
      : { whole: false, args: {} }
  } catch {
    return { whole: false, args: {} }
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

/** Runs the agent, yielding events as the answer streams and tools run. Ends with exactly one end. */
export async function* runAgent<C>(opts: RunAgentOptions<C>): AsyncGenerator<AgentEvent> {
  const added: LlmMessage[] = [{ role: "user", content: opts.userMessage }]
  try {
    yield* run(opts, added)
  } catch (error) {
    // Nothing escapes without an end (a tool's schema that can't become JSON Schema…).
    yield { type: "error", message: errorMessage(error), messages: added }
  }
}

async function* run<C>(opts: RunAgentOptions<C>, added: LlmMessage[]): AsyncGenerator<AgentEvent> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS
  const signal = opts.signal ?? new AbortController().signal
  const defs = toDefs(opts.tools)
  const prior: LlmMessage[] = []
  if (opts.system !== undefined) prior.push({ role: "system", content: opts.system })
  if (opts.history !== undefined) prior.push(...opts.history)
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
  const usedIds = new Set<string>(prior.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])))
  const shownBulky = new Set<string>(usedIds)
  // A call id nobody has used, in this chat (a provider may send none, or repeat one).
  const runId = Math.random().toString(36).slice(2, 8)
  let made = 0
  const freshId = (id: string) => {
    let out = id
    while (out === "" || usedIds.has(out)) out = `call-${runId}-${(made += 1)}`
    usedIds.add(out)
    return out
  }

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
    // Stopped as the reply came: never stored as a complete answer.
    if (signal.aborted) {
      yield { type: "aborted", messages: added }
      return
    }
    const details =
      result.reasoningDetails !== undefined ? { reasoningDetails: result.reasoningDetails } : {}
    if (result.kind === "text") {
      added.push({ role: "assistant", content: result.text, ...details })
      yield { type: "assistant_text", text: result.text }
      yield { type: "done", messages: added, ...(result.truncated === true && { truncated: true }) }
      return
    }
    const turnCalls = result.calls.map((c) => {
      const read = readArgs(c.arguments)
      // Stored replayable: whole JSON, `{}` for none or broken ones.
      const stored = read.whole && c.arguments.trim() !== "" ? c.arguments : "{}"
      return { ...c, id: freshId(c.id), ...read, stored }
    })
    added.push({
      role: "assistant",
      content: result.text ?? "",
      toolCalls: turnCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.stored })),
      ...details,
    })
    for (const call of turnCalls) {
      // Every call starts and ends, in the history and for the UI (a stopped one too).
      yield { type: "tool_start", callId: call.id, toolName: call.name, args: call.args }
      let output: unknown
      if (!call.whole) {
        output = toolRejected(
          call.name,
          result.truncated === true
            ? "your arguments were cut off (the reply hit its length limit): make the call again, shorter"
            : "your arguments weren't a valid JSON object: make the call again with valid JSON",
        )
      } else if (signal.aborted) {
        output = toolAborted(call.name)
      } else {
        output = await executeToolCall(call.name, call.args, opts.tools, opts.context, signal)
      }
      const { content, shown } = serializeToolResult(output, call.name)
      yield { type: "tool_result", callId: call.id, toolName: call.name, result: shown }
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
      yield {
        type: "tool_pending",
        toolName: ev.name,
        ...(ev.id !== undefined && { callId: ev.id }),
      }
    } else {
      final = ev.turn
    }
  }
  // A stream that ended without its turn is cut short: never taken as a complete answer.
  if (final === undefined) throw new Error("the model's reply ended before it was complete")
  return final
}

/** An error's text, whatever was thrown (never throws itself). */
function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return "an error that can't be shown"
  }
}
