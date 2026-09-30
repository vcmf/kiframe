import { describe, expect, it } from "vitest"
import type { ChatCompletionChunk } from "openai/resources/chat/completions"
import type { LlmStreamEvent } from "../src/types.ts"
import { assembleStreamedTurn } from "../src/stream-assemble.ts"

async function* chunksOf(...cs: unknown[]): AsyncGenerator<ChatCompletionChunk> {
  for (const c of cs) yield await Promise.resolve(c as ChatCompletionChunk)
}

const textChunk = (content: string) => ({
  choices: [{ index: 0, delta: { content }, finish_reason: null }],
})
const toolChunk = (
  index: number,
  id: string | undefined,
  name: string | undefined,
  args: string,
) => ({
  choices: [
    {
      index: 0,
      finish_reason: null,
      delta: { tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] },
    },
  ],
})

const collect = async (chunks: AsyncIterable<ChatCompletionChunk>): Promise<LlmStreamEvent[]> => {
  const out: LlmStreamEvent[] = []
  for await (const ev of assembleStreamedTurn(chunks)) out.push(ev)
  return out
}

describe("assembleStreamedTurn", () => {
  it("emits text deltas then a final text turn", async () => {
    const events = await collect(chunksOf(textChunk("Hel"), textChunk("lo")))
    expect(events).toEqual([
      { kind: "delta", text: "Hel" },
      { kind: "delta", text: "lo" },
      { kind: "final", turn: { kind: "text", text: "Hello" } },
    ])
  })

  it("stitches tool-call fragments (id/name once, arguments across chunks) by index", async () => {
    const events = await collect(
      chunksOf(
        toolChunk(0, "c1", "create_note", '{"ti'),
        toolChunk(0, undefined, undefined, 'tle":"x"}'),
      ),
    )
    expect(events).toEqual([
      { kind: "tool_start", name: "create_note", id: "c1" }, // announced as soon as the name is known
      {
        kind: "final",
        turn: {
          kind: "tool_calls",
          calls: [{ id: "c1", name: "create_note", arguments: '{"title":"x"}' }],
          text: "", // no text came with the call (kept when there is)
        },
      },
    ])
  })

  it("announces tool_start once (on the name), before the args finish", async () => {
    const events = await collect(
      chunksOf(
        toolChunk(0, "c1", "write_note", ""), // name known, no args yet
        toolChunk(0, undefined, undefined, '{"content":"a very '), // args stream…
        toolChunk(0, undefined, undefined, 'long note"}'),
      ),
    )
    expect(events[0]).toEqual({ kind: "tool_start", name: "write_note", id: "c1" })
    expect(events.filter((e) => e.kind === "tool_start")).toHaveLength(1) // not one per arg chunk
    expect(events.at(-1)).toMatchObject({ kind: "final", turn: { kind: "tool_calls" } })
  })

  it("assembles two parallel tool calls at different indices", async () => {
    const events = await collect(
      chunksOf(toolChunk(0, "a", "f", "{}"), toolChunk(1, "b", "g", "{}")),
    )
    expect(events.filter((e) => e.kind === "tool_start")).toEqual([
      { kind: "tool_start", name: "f", id: "a" },
      { kind: "tool_start", name: "g", id: "b" },
    ])
    const final = events.at(-1)
    if (final?.kind === "final" && final.turn.kind === "tool_calls") {
      expect(final.turn.calls.map((c) => c.id)).toEqual(["a", "b"])
    }
  })

  it("ignores chunks with no choices/delta", async () => {
    const events = await collect(chunksOf({ choices: [] }, textChunk("hi")))
    expect(events).toEqual([
      { kind: "delta", text: "hi" },
      { kind: "final", turn: { kind: "text", text: "hi" } },
    ])
  })

  it("captures the reasoning channel — DeepSeek `reasoning_content` and OpenRouter `reasoning`", async () => {
    const reasoningContentChunk = (t: string) => ({
      choices: [{ index: 0, finish_reason: null, delta: { reasoning_content: t } }],
    })
    const reasoningChunk = (t: string) => ({
      choices: [{ index: 0, finish_reason: null, delta: { reasoning: t } }],
    })
    const events = await collect(
      chunksOf(reasoningContentChunk("Let me "), reasoningChunk("think."), textChunk("Answer")),
    )
    expect(events).toEqual([
      { kind: "reasoning", text: "Let me " },
      { kind: "reasoning", text: "think." },
      { kind: "delta", text: "Answer" },
      { kind: "final", turn: { kind: "text", text: "Answer" } },
    ])
  })

  it("leaves a stream without a reasoning channel unchanged", async () => {
    const events = await collect(chunksOf(textChunk("hi")))
    expect(events.some((e) => e.kind === "reasoning")).toBe(false)
  })

  it("an empty reasoning_content does not mask a populated reasoning in the same delta", async () => {
    const bothChunk = {
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: { reasoning_content: "", reasoning: "real thought" },
        },
      ],
    }
    const events = await collect(chunksOf(bothChunk, textChunk("A")))
    expect(events).toEqual([
      { kind: "reasoning", text: "real thought" },
      { kind: "delta", text: "A" },
      { kind: "final", turn: { kind: "text", text: "A" } },
    ])
  })
})
