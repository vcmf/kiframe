import { z } from "zod"
import {
  CUT_SHORT,
  isToolSoftError,
  toolAborted,
  toolNotRun,
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
function serializeToolResult(output: unknown, toolName: string): string {
  try {
    return JSON.stringify(output) ?? emptyResultText(toolName)
  } catch (error) {
    const reason = new Error(`its result couldn't be read: ${errorMessage(error)}`)
    return JSON.stringify(toolThrew(toolName, reason))
  }
}

/** A result for the UI: the plain value the model read (safe to send across IPC). */
function plain(content: string): unknown {
  try {
    return JSON.parse(content) as unknown
  } catch {
    return content
  }
}

/** How long a stopped tool may take to finish on its own (its real result kept). */
export const STOP_GRACE_MS = 2000

/** One abort listener for a stretch of work (removed once it's over: none left on the signal). */
interface StopWatch {
  promise: Promise<void>
  dispose: () => void
}

function stopWatch(signal: AbortSignal): StopWatch {
  let listener: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    if (signal.aborted) resolve()
    else {
      listener = () => resolve()
      signal.addEventListener("abort", listener, { once: true })
    }
  })
  return {
    promise,
    dispose: () => {
      if (listener !== undefined) signal.removeEventListener("abort", listener)
    },
  }
}

/**
 * `work`'s value, or `stopped` if the stop comes first. The work is left to finish, its failure
 * handled (never an unhandled rejection).
 */
async function orStop<T>(
  work: Promise<T>,
  watch: StopWatch,
): Promise<{ stopped: false; value: T } | { stopped: true }> {
  work.catch(() => undefined)
  return Promise.race([
    work.then((value) => ({ stopped: false as const, value })),
    watch.promise.then(() => ({ stopped: true as const })),
  ])
}

/** The value, or the stop as an error (the run ends aborted). */
function unlessStopped<T>(result: { stopped: false; value: T } | { stopped: true }): T {
  if (result.stopped) throw new Error("stopped")
  return result.value
}

/** `work`'s value if it settles within `ms` (the timer cleared either way). */
async function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms)
  })
  try {
    return await Promise.race([work.then((value) => ({ settled: true as const, value })), late])
  } finally {
    clearTimeout(timer)
  }
}

/** Gives every call of the last assistant turn a result (an error cut the turn short: not run). */
function closeCalls(added: LlmMessage[], reason: string): void {
  const index = added.findLastIndex((m) => m.role === "assistant")
  const assistant = added[index]
  if (assistant?.role !== "assistant") return
  const answered = new Set(
    added.slice(index + 1).flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])),
  )
  for (const c of assistant.toolCalls ?? []) {
    if (answered.has(c.id)) continue
    const content = JSON.stringify(toolNotRun(c.name, reason))
    added.push({ role: "tool", toolCallId: c.id, toolName: c.name, content })
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
  /**
   * Called when a stop left a tool running (one that doesn't heed its signal): `settled` resolves
   * once it has finished. A host starts its next run after that (a recording still writing, an
   * approval still open), with its own time limit.
   */
  onLeftBehind?: (settled: Promise<void>) => void
}

/** Runs the agent, yielding events as the answer streams and tools run. Ends with exactly one end. */
export async function* runAgent<C>(opts: RunAgentOptions<C>): AsyncGenerator<AgentEvent> {
  const added: LlmMessage[] = [{ role: "user", content: opts.userMessage }]
  let ended = false
  try {
    for await (const event of run(opts, added)) {
      if (END.has(event.type)) ended = true
      yield event
    }
  } catch (error) {
    // After the end (the host threw into it): never a second end.
    if (ended) throw error
    // Nothing escapes without an end (a tool's schema that can't become JSON Schema…), and every
    // call keeps a result (the stored history stays replayable).
    closeCalls(added, errorMessage(error))
    yield { type: "error", message: errorMessage(error), messages: added }
  }
}

const END = new Set<AgentEvent["type"]>(["done", "aborted", "turn_limit", "error"])

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
  const shownBulky = new Set<string>(
    prior.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])),
  )
  // Ids as the provider gave them (a thought signature is bound to its call's id): only a missing
  // one, or one repeated within its turn, gets a new one.
  const runId = Math.random().toString(36).slice(2, 8)
  let made = 0

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
    const inTurn = new Set<string>()
    const turnCalls = result.calls.map((c) => {
      const read = readArgs(c.arguments)
      // Stored replayable: whole JSON, `{}` for none or broken ones.
      const stored = read.whole && c.arguments.trim() !== "" ? c.arguments : "{}"
      const id = c.id === "" || inTurn.has(c.id) ? `call-${runId}-${(made += 1)}` : c.id
      inTurn.add(id)
      return { ...c, id, ...read, stored }
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
        // At the stop, the tool gets a grace period to finish (its real result is kept: a recording
        // it finalized); one that doesn't finish in it is left running, reported to the host.
        const running = executeToolCall(call.name, call.args, opts.tools, opts.context, signal)
        const watch = stopWatch(signal)
        try {
          const first = await orStop(running, watch)
          if (!first.stopped) output = first.value
          else {
            const late = await within(running, STOP_GRACE_MS)
            if (late.settled) output = late.value
            else {
              output = toolAborted(call.name)
              try {
                opts.onLeftBehind?.(running.then(() => undefined))
              } catch {
                // the host's callback never ends the run (nor misrecords the call)
              }
            }
          }
        } finally {
          watch.dispose()
        }
      }
      // Stored before it's shown: a host throwing at the event never makes a run call look unrun.
      const content = serializeToolResult(output, call.name)
      added.push({ role: "tool", toolCallId: call.id, toolName: call.name, content })
      yield { type: "tool_result", callId: call.id, toolName: call.name, result: plain(content) }
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
  // A client that doesn't heed the signal still ends at the stop (one watch for the whole turn).
  const watch = stopWatch(signal)
  try {
    return yield* streamOrComplete(llm, messages, defs, signal, watch)
  } finally {
    watch.dispose()
  }
}

async function* streamOrComplete(
  llm: LlmClient,
  messages: LlmMessage[],
  defs: LlmToolDef[],
  signal: AbortSignal,
  watch: StopWatch,
): AsyncGenerator<AgentEvent, LlmTurn> {
  if (llm.completeStream === undefined) {
    const turn = unlessStopped(await orStop(llm.complete(messages, defs, signal), watch))
    // The text a model writes with its tool calls is shown (a final text is, by the caller).
    if (turn.kind === "tool_calls" && turn.text !== undefined && turn.text !== "") {
      yield { type: "assistant_text", text: turn.text }
    }
    return turn
  }
  let text = ""
  let reasoning = ""
  let final: LlmTurn | undefined
  const stream = llm.completeStream(messages, defs, signal)[Symbol.asyncIterator]()
  // Closed at the stop (its own cleanup's failure is no one's to handle), then the stop.
  const close = () => void Promise.resolve(stream.return?.()).catch(() => undefined)
  for (;;) {
    // Stopped while an event was being handled: no step taken.
    if (signal.aborted) {
      close()
      throw new Error("stopped")
    }
    const next = await orStop(stream.next(), watch)
    if (next.stopped) close()
    const step = unlessStopped(next)
    if (step.done === true) break
    const ev = step.value
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
  if (final === undefined) throw new Error(CUT_SHORT)
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
