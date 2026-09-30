import type { ChatCompletion } from "openai/resources/chat/completions"
import { describe, expect, it } from "vitest"
import { fromOpenAiMessage, OpenAiCompatibleClient, toOpenAiMessages } from "../src/index.ts"

describe("OpenAiCompatibleClient", () => {
  it("sends structured tool calls and results, and passes the abort signal", async () => {
    let options: { signal?: AbortSignal } | undefined
    let sent: unknown
    const client = new OpenAiCompatibleClient(
      {
        create: (params, opts) => {
          sent = params.messages
          options = opts
          return Promise.resolve({
            choices: [{ message: { role: "assistant", content: "ok", refusal: null } }],
          } as unknown as ChatCompletion)
        },
      },
      "deepseek/deepseek-v4.1-flash",
    )
    const signal = new AbortController().signal
    const turn = await client.complete(
      [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }],
        },
        { role: "tool", toolCallId: "c1", content: "{}" },
      ],
      [],
      signal,
    )
    expect(turn).toEqual({ kind: "text", text: "ok" })
    expect(options?.signal).toBe(signal)
    expect(sent).toEqual(
      toOpenAiMessages([
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "echo", arguments: "{}" }],
        },
        { role: "tool", toolCallId: "c1", content: "{}" },
      ]),
    )
  })

  it("keeps the text a model writes with its tool calls", () => {
    expect(
      fromOpenAiMessage({
        role: "assistant",
        content: "Checking the page first.",
        refusal: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "snapshot", arguments: "{}" } },
        ],
      }),
    ).toEqual({
      kind: "tool_calls",
      text: "Checking the page first.",
      calls: [{ id: "c1", name: "snapshot", arguments: "{}" }],
    })
  })
})

describe("reasoning state on the wire", () => {
  it("sends reasoning_details back on the assistant message, and reads them from a reply", () => {
    const details = [{ type: "reasoning.encrypted", data: "sig" }]
    expect(
      toOpenAiMessages([{ role: "assistant", content: "", reasoningDetails: details }])[0],
    ).toMatchObject({ reasoning_details: details })
    expect(
      fromOpenAiMessage({
        role: "assistant",
        content: "ok",
        refusal: null,
        reasoning_details: details,
      } as unknown as Parameters<typeof fromOpenAiMessage>[0]),
    ).toEqual({ kind: "text", text: "ok", reasoningDetails: details })
  })
})

describe("reasoning state: OpenRouter only, fragments joined", () => {
  it("never sends reasoning_details to another API", () => {
    const details = [{ type: "reasoning.encrypted", data: "sig" }]
    const [m] = toOpenAiMessages(
      [{ role: "assistant", content: "", reasoningDetails: details }],
      false,
    )
    expect(m).not.toHaveProperty("reasoning_details")
  })

  it("joins streamed fragments of one entry (same index), keeps others apart", async () => {
    const { assembleStreamedTurn } = await import("../src/stream-assemble.ts")
    const chunk = (details: unknown[]) => ({
      choices: [{ index: 0, delta: { reasoning_details: details } }],
    })
    async function* chunks() {
      yield await Promise.resolve(chunk([{ type: "reasoning.text", index: 0, text: "Think" }]))
      yield chunk([{ type: "reasoning.text", index: 0, text: "ing" }])
      yield chunk([{ type: "reasoning.encrypted", index: 1, data: "sig" }])
    }
    let final: unknown
    for await (const ev of assembleStreamedTurn(chunks() as never))
      if (ev.kind === "final") final = ev.turn
    expect(final).toMatchObject({
      reasoningDetails: [
        { type: "reasoning.text", index: 0, text: "Thinking" },
        { type: "reasoning.encrypted", index: 1, data: "sig" },
      ],
    })
  })
})
