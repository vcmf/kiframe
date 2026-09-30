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
  ToolContext,
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

/** A tool result as the model reads it (never empty: some models end their turn on one). */
const serializeToolResult = (output: unknown, toolName: string): string => {
  const s = JSON.stringify(output)
  return s === undefined ? emptyResultText(toolName) : s
}

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

/**
 * Runs one tool call and returns the model-facing result: the tool's own output, or a structured
 * failure (unknown tool, a thrown error, the tool's own `{ error }`). No failure ends the run.
 */
export async function executeToolCall<C>(
  name: string,
  args: Record<string, unknown>,
  tools: Tool<C>[],
  ctx: ToolContext<C>,
): Promise<unknown> {
  const tool = tools.find((t) => t.name === name)
  if (tool === undefined) return unknownTool(name)
  try {
    const result = await tool.run(args, ctx)
    return isToolSoftError(result) ? toolRejected(tool.name, result.error) : result
  } catch (err) {
    return toolThrew(tool.name, err)
  }
}

export type RunAgentOptions<C> = {
  userMessage: string
  tools: Tool<C>[]
  llm: LlmClient
  /** The host's context for the tools (the project, the browser, `requestUser`…). */
  context: C
  system?: string
  /** Prior turns, structured (a previous run's `done.messages`), so the agent remembers the chat. */
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
  const ctx: ToolContext<C> = { ...opts.context, signal }
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
  const shownBulky = new Set<string>()

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
    if (result.kind === "text") {
      added.push({ role: "assistant", content: result.text })
      yield { type: "assistant_text", text: result.text }
      yield { type: "done", messages: added }
      return
    }
    added.push({ role: "assistant", content: result.text ?? "", toolCalls: result.calls })
    for (const call of result.calls) {
      if (signal.aborted) {
        // Every call gets a result (the history stays well-formed): the ones not run say so.
        added.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: JSON.stringify({ ok: false, error: "aborted", message: "the run was stopped" }),
        })
        continue
      }
      const args = parseArgs(call.arguments)
      yield { type: "tool_start", callId: call.id, toolName: call.name, args }
      const output = await executeToolCall(call.name, args, opts.tools, ctx)
      yield { type: "tool_result", callId: call.id, toolName: call.name, result: output }
      added.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: serializeToolResult(output, call.name),
      })
    }
  }
  if (signal.aborted) {
    yield { type: "aborted", messages: added }
    return
  }
  yield { type: "turn_limit", maxTurns, messages: added }
}

/** One model turn, streamed when the client can: text and reasoning as they come. */
async function* modelTurn(
  llm: LlmClient,
  messages: LlmMessage[],
  defs: LlmToolDef[],
  signal: AbortSignal,
): AsyncGenerator<AgentEvent, LlmTurn> {
  if (llm.completeStream === undefined) return await llm.complete(messages, defs, signal)
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
    } else if (ev.kind === "final") {
      final = ev.turn
    }
  }
  return final ?? { kind: "text", text }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
