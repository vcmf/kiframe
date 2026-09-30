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

/** Our messages → OpenAI chat messages (structured tool calls and results, never flattened). */
export const toOpenAiMessages = (messages: LlmMessage[]): ChatCompletionMessageParam[] =>
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
export const fromOpenAiMessage = (message?: ChatCompletionMessage): LlmTurn => {
  const calls: LlmToolCall[] = []
  for (const tc of message?.tool_calls ?? []) {
    if (tc.type === "function") {
      calls.push({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments })
    }
  }
  const text = message?.content ?? ""
  return calls.length > 0 ? { kind: "tool_calls", calls, text } : { kind: "text", text }
}

/** The SDK behind a completer, from the config. */
export const makeCompleter = (config: LlmConfig): ChatCompleter => {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? BASE_URLS[config.provider ?? "openrouter"],
    maxRetries: config.maxRetries ?? 3,
  })
  return {
    create: (params, options) => client.chat.completions.create(params, options),
    createStream: (params, options) => client.chat.completions.create(params, options),
  }
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly #completer: ChatCompleter
  readonly #model: string

  constructor(completer: ChatCompleter, model: string) {
    this.#completer = completer
    this.#model = model
  }

  static fromConfig(config: LlmConfig): OpenAiCompatibleClient {
    return new OpenAiCompatibleClient(makeCompleter(config), config.model)
  }

  #params(messages: LlmMessage[], tools: LlmToolDef[]) {
    return {
      model: this.#model,
      messages: toOpenAiMessages(messages),
      ...(tools.length > 0 && { tools: toOpenAiTools(tools), tool_choice: "auto" as const }),
    }
  }

  async complete(messages: LlmMessage[], tools: LlmToolDef[], signal?: AbortSignal) {
    const res = await this.#completer.create(
      this.#params(messages, tools),
      signal ? { signal } : {},
    )
    return fromOpenAiMessage(res.choices[0]?.message)
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
