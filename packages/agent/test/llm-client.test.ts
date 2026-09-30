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
