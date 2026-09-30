/**
 * Assemble an OpenAI streaming chunk sequence into our `LlmStreamEvent`s:
 * text deltas as they arrive, then one `final` turn. Tool-call fragments stream
 * by `index` (id/name/arguments arrive piecemeal) and are stitched back together.
 * Used by the OpenAI-compatible client (ported from cooldown).
 */
import type { ChatCompletionChunk } from "openai/resources/chat/completions"
import type { LlmStreamEvent, LlmToolCall, LlmTurn } from "./types.ts"

export async function* assembleStreamedTurn(
  chunks: AsyncIterable<ChatCompletionChunk>,
): AsyncGenerator<LlmStreamEvent> {
  let text = ""
  // The provider's opaque reasoning state (OpenRouter `reasoning_details`), kept to send back:
  // streamed fragments of one entry (same `index`) are joined, as the provider concatenates them.
  const reasoningDetails: unknown[] = []
  let finishReason: string | null | undefined
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  const announced = new Set<number>()

  for await (const chunk of chunks) {
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
      for (const entry of r.reasoning_details as unknown[]) mergeDetail(reasoningDetails, entry)
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

/** Adds a streamed `reasoning_details` fragment: joined to the entry of the same index, if any. */
function mergeDetail(details: unknown[], entry: unknown): void {
  const e = entry as Record<string, unknown> | null
  const index = typeof e?.index === "number" ? e.index : undefined
  const last = details.at(-1) as Record<string, unknown> | undefined
  if (e === null || index === undefined || last?.index !== index || last.type !== e.type) {
    details.push(entry)
    return
  }
  for (const [key, value] of Object.entries(e)) {
    const prev = last[key]
    const joined = key === "text" || key === "summary" || key === "data" || key === "signature"
    if (joined && typeof value === "string" && typeof prev === "string") last[key] = prev + value
    else if (prev === undefined) last[key] = value
  }
}
