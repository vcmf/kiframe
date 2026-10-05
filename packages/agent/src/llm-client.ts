import OpenAI from "openai"
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions"
import { assembleStreamedTurn } from "./stream-assemble.ts"
import { CUT_SHORT } from "./tool-result.ts"
import type {
  LlmClient,
  LlmMessage,
  LlmStreamEvent,
  LlmToolCall,
  LlmToolDef,
  LlmTurn,
} from "./types.ts"

// An OpenAI-compatible LLM client (ported from cooldown's BYOK client): OpenRouter by default
// (Claude, Gemini, DeepSeek… with one key), OpenAI direct, or any compatible base URL (a proxy).
// Retries with backoff on 429, 5xx and connection errors are the SDK's own (`maxRetries`).

export type Provider = "openrouter" | "openai"

export type LlmConfig = {
  apiKey: string
  model: string
  provider?: Provider
  /** Overrides the provider's base URL (an OpenAI-compatible proxy). */
  baseURL?: string
  /** Retries on 429 / 5xx / connection errors, with the SDK's backoff. Default 3. */
  maxRetries?: number
  /** The fetch the SDK uses (a proxy agent; tests). Default: the global fetch. */
  fetch?: typeof fetch
  /**
   * Send the provider's reasoning state back (OpenRouter's `reasoning_details`). Default: when the
   * endpoint is OpenRouter's; set it for a gateway in front of OpenRouter.
   */
  sendReasoning?: boolean
  /**
   * How OpenRouter picks the model's provider (its `provider.sort`): `throughput` is what the
   * `:nitro` suffix does, the id kept plain. Sent to OpenRouter only (another API would refuse it).
   * Default: OpenRouter's own routing.
   */
  providerSort?: "throughput" | "price" | "latency"
}

/** The SDK calls the client makes: injectable, so tests never reach the network. */
export type ChatCompleter = {
  create(
    params: ChatCompletionCreateParamsNonStreaming,
    options: { signal?: AbortSignal },
  ): Promise<ChatCompletion>
  createStream?(
    params: ChatCompletionCreateParamsStreaming,
    options: { signal?: AbortSignal },
  ): Promise<AsyncIterable<ChatCompletionChunk>>
}

const BASE_URLS: Record<Provider, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
}

/**
 * Our messages → OpenAI chat messages (structured tool calls and results, never flattened).
 * `reasoning`: send the provider's reasoning state back (OpenRouter only: another API may refuse
 * the field).
 */
export const toOpenAiMessages = (
  messages: LlmMessage[],
  reasoning = false,
): ChatCompletionMessageParam[] =>
  messages.map((m): ChatCompletionMessageParam => {
    if (m.role === "system") return { role: "system", content: m.content }
    if (m.role === "user") {
      if (!m.images?.length) return { role: "user", content: m.content }
      const parts: ChatCompletionContentPart[] = []
      if (m.content) parts.push({ type: "text", text: m.content })
      for (const img of m.images) parts.push({ type: "image_url", image_url: { url: img.url } })
      return { role: "user", content: parts }
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content }
    return {
      role: "assistant",
      content: m.content,
      // Sent back as the provider gave it (OpenRouter: Gemini's thought signatures, Claude's thinking).
      ...(reasoning &&
        m.reasoningDetails !== undefined && { reasoning_details: m.reasoningDetails }),
      ...(m.toolCalls !== undefined &&
        m.toolCalls.length > 0 && {
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        }),
    }
  })

/** Our tool definitions → OpenAI function tools. */
export const toOpenAiTools = (tools: LlmToolDef[]): ChatCompletionTool[] =>
  tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))

/** An OpenAI assistant message → our turn (tool calls, with the text that came with them). */
export const fromOpenAiMessage = (
  message?: ChatCompletionMessage,
  finishReason?: string | null,
): LlmTurn => {
  const calls: LlmToolCall[] = []
  for (const tc of message?.tool_calls ?? []) {
    if (tc.type === "function") {
      calls.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })
    }
  }
  const text = message?.content ?? ""
  const raw = (message as { reasoning_details?: unknown } | undefined)?.reasoning_details
  const extra = {
    ...(Array.isArray(raw) && { reasoningDetails: raw as unknown[] }),
    ...(finishReason === "length" && { truncated: true }),
  }
  return calls.length > 0
    ? { kind: "tool_calls", calls, text, ...extra }
    : { kind: "text", text, ...extra }
}

/** Whether a config reaches OpenRouter (the one API that takes `reasoning_details` back). */
export const isOpenRouter = (config: LlmConfig): boolean => {
  const url = config.baseURL ?? BASE_URLS[config.provider ?? "openrouter"]
  try {
    return new URL(url).hostname === "openrouter.ai"
  } catch {
    return false
  }
}

/** The SDK behind a completer, from the config. */
export const makeCompleter = (config: LlmConfig): ChatCompleter => {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? BASE_URLS[config.provider ?? "openrouter"],
    maxRetries: config.maxRetries ?? 3,
    ...(config.fetch !== undefined && { fetch: config.fetch }),
  })
  return {
    create: (params, options) => client.chat.completions.create(params, options),
    createStream: (params, options) => client.chat.completions.create(params, options),
  }
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly #completer: ChatCompleter
  readonly #model: string
  readonly #reasoning: boolean
  readonly #sort: LlmConfig["providerSort"]

  /**
   * `sendReasoning`: send the reasoning state back (OpenRouter's field; off for other APIs).
   * `providerSort`: OpenRouter's provider order (OpenRouter only).
   */
  constructor(
    completer: ChatCompleter,
    model: string,
    sendReasoning = false,
    providerSort?: LlmConfig["providerSort"],
  ) {
    this.#completer = completer
    this.#model = model
    this.#reasoning = sendReasoning
    this.#sort = providerSort
  }

  static fromConfig(config: LlmConfig): OpenAiCompatibleClient {
    const openRouter = isOpenRouter(config)
    const reasoning = config.sendReasoning ?? openRouter
    const sort = openRouter ? config.providerSort : undefined
    return new OpenAiCompatibleClient(makeCompleter(config), config.model, reasoning, sort)
  }

  #params(messages: LlmMessage[], tools: LlmToolDef[]) {
    return {
      model: this.#model,
      ...(this.#sort !== undefined && { provider: { sort: this.#sort } }),
      messages: toOpenAiMessages(messages, this.#reasoning),
      ...(tools.length > 0 && { tools: toOpenAiTools(tools), tool_choice: "auto" as const }),
    }
  }

  async complete(messages: LlmMessage[], tools: LlmToolDef[], signal?: AbortSignal) {
    const res = await this.#completer.create(
      this.#params(messages, tools),
      signal ? { signal } : {},
    )
    // A body without choices (OpenRouter's upstream failure as a 200) or an error choice: its
    // message; no finish reason: cut short (the same rule as a stream).
    const body = res as { choices?: ChatCompletion["choices"]; error?: { message?: unknown } }
    const choice = body.choices?.[0] as
      (ChatCompletion["choices"][number] & { error?: { message?: unknown } }) | undefined
    // An error there is the failure (its message, when it has one, says what).
    if (choice?.error !== undefined || body.error !== undefined) {
      const message = [choice?.error?.message, body.error?.message].find(
        (m) => typeof m === "string" && m !== "",
      )
      throw new Error(typeof message === "string" ? `${CUT_SHORT}: ${message}` : CUT_SHORT)
    }
    const reason = choice?.finish_reason as string | null | undefined
    if (choice === undefined || reason === undefined || reason === null || reason === "error") {
      throw new Error(CUT_SHORT)
    }
    return fromOpenAiMessage(choice.message, reason)
  }

  /** Streams when the completer can, else one `final` event from `complete`. */
  async *completeStream(
    messages: LlmMessage[],
    tools: LlmToolDef[],
    signal?: AbortSignal,
  ): AsyncGenerator<LlmStreamEvent> {
    if (this.#completer.createStream === undefined) {
      yield { kind: "final", turn: await this.complete(messages, tools, signal) }
      return
    }
    const stream = await this.#completer.createStream(
      { ...this.#params(messages, tools), stream: true },
      signal ? { signal } : {},
    )
    yield* assembleStreamedTurn(stream)
  }
}
