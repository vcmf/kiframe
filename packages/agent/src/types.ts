import { z } from "zod"

// The agent engine's types (ported from cooldown's engine, made generic over the tools' context).
// `LlmClient` is the swappable boundary: a scripted mock (tests) and the OpenAI-compatible client
// both implement it, so the loop and tools are tested with no network.

export type LlmToolCall = { id: string; name: string; arguments: string }

/** An image attached to a user turn: a `data:` URL (or a remote URL). */
export type LlmImage = { url: string }

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: LlmImage[] | undefined }
  | {
      role: "assistant"
      content: string
      toolCalls?: LlmToolCall[] | undefined
      /** The provider's opaque reasoning state (OpenRouter `reasoning_details`): sent back as is. */
      reasoningDetails?: unknown[] | undefined
    }
  // `toolName` lets the loop resolve per-tool policy (keep a result whole) when it derives the
  // model-facing view; clients ignore it.
  | { role: "tool"; toolCallId: string; content: string; toolName?: string | undefined }

/**
 * One model turn: a final answer, or tool calls (with any text the model wrote before them).
 * `truncated`: the provider stopped it at its length limit (`finish_reason: "length"`).
 */
export type LlmTurn =
  | {
      kind: "text"
      text: string
      reasoningDetails?: unknown[] | undefined
      truncated?: boolean | undefined
    }
  | {
      kind: "tool_calls"
      calls: LlmToolCall[]
      text?: string | undefined
      reasoningDetails?: unknown[] | undefined
      truncated?: boolean | undefined
    }

export type LlmToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A streamed turn: text deltas, an early `tool_start` once a call's name is known, the turn. */
export type LlmStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_start"; name: string; id?: string | undefined }
  | { kind: "final"; turn: LlmTurn }

export interface LlmClient {
  /** One turn, resolved atomically (tests, and the non-streaming fallback). */
  complete(messages: LlmMessage[], tools: LlmToolDef[], signal?: AbortSignal): Promise<LlmTurn>
  /** Streaming variant: preferred by the loop when present. */
  completeStream?(
    messages: LlmMessage[],
    tools: LlmToolDef[],
    signal?: AbortSignal,
  ): AsyncIterable<LlmStreamEvent>
}

/**
 * A tool of a host whose context is `C` (passed as is: a class instance keeps its methods), with the
 * run's cancellation signal.
 */
export type Tool<C> = {
  name: string
  description: string
  /** Zod schema for the arguments; the loop turns it into the JSON Schema the LLM sees. */
  parameters: z.ZodType
  run: (args: unknown, ctx: C, signal: AbortSignal) => Promise<unknown>
  /** Never elide this tool's result from the model's context (bounded, must-read outputs). */
  keepFullResult?: boolean
}

/**
 * Defines a tool from a Zod parameter schema: it types `run`'s args, validates the model's call at
 * runtime (invalid arguments come back as a structured error the model can correct), and becomes
 * the JSON Schema the LLM sees.
 */
export const defineTool = <C, S extends z.ZodType>(def: {
  name: string
  description: string
  parameters: S
  run: (args: z.infer<S>, ctx: C, signal: AbortSignal) => Promise<unknown>
  keepFullResult?: boolean
}): Tool<C> => ({
  name: def.name,
  description: def.description,
  parameters: def.parameters,
  ...(def.keepFullResult !== undefined && { keepFullResult: def.keepFullResult }),
  run: async (args, ctx, signal) => {
    const parsed = def.parameters.safeParse(args)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")
      return { error: `invalid arguments: ${detail}` }
    }
    return def.run(parsed.data, ctx, signal)
  },
})

/**
 * What a run yields, in order. The end event comes as soon as the run is over (a stop: at once;
 * a tool the stop left running is reported through `onLeftBehind`). Every tool event carries its call's id (parallel calls of one tool
 * stay paired). A run ends with exactly one of `done` (with the messages it added: the structured
 * history to store and replay, every call with its result), `aborted`, `turn_limit` or `error`.
 * History is this engine's own output (a run's `messages`), replayed as is.
 */
export type AgentEvent =
  | { type: "assistant_text"; text: string }
  | { type: "reasoning"; text: string }
  /**
   * A call's name is known, its arguments still streaming: shown at once. A call that reaches the
   * loop gets its `tool_start` (same id, when the provider sent one and didn't repeat it in the
   * turn: a repeated one is renamed there) and `tool_result`, a stopped one too; the run's end
   * closes any pending call that didn't (the reply failed or was stopped).
   */
  | { type: "tool_pending"; toolName: string; callId?: string | undefined }
  | { type: "tool_start"; callId: string; toolName: string; args: unknown }
  | { type: "tool_result"; callId: string; toolName: string; result: unknown }
  /** `truncated`: the last answer hit the provider's length limit (it's incomplete). */
  | { type: "done"; messages: LlmMessage[]; truncated?: boolean | undefined }
  | { type: "aborted"; messages: LlmMessage[] }
  | { type: "turn_limit"; maxTurns: number; messages: LlmMessage[] }
  | { type: "error"; message: string; messages: LlmMessage[] }
