/**
 * Assemble an OpenAI streaming chunk sequence into our `LlmStreamEvent`s:
 * text deltas as they arrive, then one `final` turn. Tool-call fragments stream
 * by `index` (id/name/arguments arrive piecemeal) and are stitched back together.
 * Used by the OpenAI-compatible client (ported from cooldown).
 */
import type { ChatCompletionChunk } from "openai/resources/chat/completions"
import { CUT_SHORT } from "./tool-result.ts"
import type { LlmStreamEvent, LlmToolCall, LlmTurn } from "./types.ts"

export async function* assembleStreamedTurn(
  chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<LlmStreamEvent> {
  let text = ""
  // The provider's opaque reasoning state (OpenRouter `reasoning_details`), kept to send back as
  // received: every streamed fragment, in order, unmodified (OpenRouter's rule for sending it back).
  const reasoningDetails: unknown[] = []
  let finishReason: string | null | undefined
  let streamError: string | undefined
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  const announced = new Set<number>()

  for await (const chunk of chunks) {
    const failed = (chunk as { error?: { message?: unknown } }).error
    if (failed !== undefined) {
      streamError = typeof failed.message === "string" ? failed.message : "the provider failed"
    }
    const choice = chunk.choices[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    const delta = choice?.delta
    if (!delta) continue
    if (delta.content) {
      text += delta.content
      yield { kind: "delta", text: delta.content }
    }
    // Provider reasoning/thinking channel — not in OpenAI's chunk type, so read
    // off the raw delta: OpenRouter uses `reasoning`, DeepSeek et al. use
    // `reasoning_content`. This text is display-only; `reasoning_details` is what goes back.
    const r = delta as {
      reasoning?: unknown
      reasoning_content?: unknown
      reasoning_details?: unknown
    }
    if (Array.isArray(r.reasoning_details)) {
      reasoningDetails.push(...(r.reasoning_details as unknown[]))
    }
    // Prefer whichever field carries actual text: an empty `reasoning_content`
    // must not mask a populated `reasoning` in the same delta.
    const reasoning =
      (typeof r.reasoning_content === "string" && r.reasoning_content) ||
      (typeof r.reasoning === "string" && r.reasoning) ||
      ""
    if (reasoning) yield { kind: "reasoning", text: reasoning }
    for (const tc of delta.tool_calls ?? []) {
      const slot = calls.get(tc.index) ?? { id: "", name: "", arguments: "" }
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.name = tc.function.name
      if (tc.function?.arguments) slot.arguments += tc.function.arguments
      calls.set(tc.index, slot)
      // Announce the tool the instant its name is known — before the (possibly
      // long) arguments finish — so the UI shows it immediately, not after a pause.
      if (slot.name && !announced.has(tc.index)) {
        announced.add(tc.index)
        yield { kind: "tool_start", name: slot.name, id: slot.id || undefined }
      }
    }
  }

  // No finish reason, or an error one (OpenRouter's upstream failure mid-stream, with its `error`):
  // cut short, never a whole turn.
  if (finishReason === undefined || finishReason === null || finishReason === "error") {
    throw new Error(streamError === undefined ? CUT_SHORT : `${CUT_SHORT}: ${streamError}`)
  }
  // Text that came with tool calls is kept (the model's note to the user before it acts).
  const extra = {
    ...(reasoningDetails.length > 0 && { reasoningDetails }),
    ...(finishReason === "length" && { truncated: true }),
  }
  const turn: LlmTurn =
    calls.size > 0
      ? { kind: "tool_calls", calls: [...calls.values()] as LlmToolCall[], text, ...extra }
      : { kind: "text", text, ...extra }
  yield { kind: "final", turn }
}
