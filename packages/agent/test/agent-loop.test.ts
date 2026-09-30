import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  type AgentEvent,
  defineTool,
  type LlmClient,
  type LlmMessage,
  type LlmTurn,
  runAgent,
} from "../src/index.ts"

// A model that plays back scripted turns, and records what it was sent.
function scripted(turns: (LlmTurn | Error)[]) {
  const seen: LlmMessage[][] = []
  const llm: LlmClient = {
    complete: (messages, _tools, signal) => {
      seen.push(messages)
      signal?.throwIfAborted()
      const next = turns.shift()
      if (next === undefined) return Promise.resolve({ kind: "text", text: "(end)" })
      if (next instanceof Error) return Promise.reject(next)
      return Promise.resolve(next)
    },
  }
  return { llm, seen }
}

const call = (id: string, name: string, args: object) => ({
  id,
  name,
  arguments: JSON.stringify(args),
})

async function collect(run: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const e of run) events.push(e)
  return events
}

type Ctx = { log: string[] }
const echo = defineTool<Ctx, z.ZodObject<{ text: z.ZodString }>>({
  name: "echo",
  description: "Echoes",
  parameters: z.object({ text: z.string() }),
  run: ({ text }, ctx) => {
    ctx.log.push(text)
    return Promise.resolve({ echoed: text })
  },
})

describe("runAgent", () => {
  it("runs tool calls with their ids, keeps the text sent with them, and returns structured history", async () => {
    const { llm, seen } = scripted([
      {
        kind: "tool_calls",
        text: "Let me echo twice.",
        calls: [call("c1", "echo", { text: "a" }), call("c2", "echo", { text: "b" })],
      },
      { kind: "text", text: "Done." },
    ])
    const ctx = { log: [] as string[] }
    const events = await collect(runAgent({ userMessage: "go", tools: [echo], llm, context: ctx }))
    expect(ctx.log).toEqual(["a", "b"])
    const starts = events.filter((e) => e.type === "tool_start")
    expect(starts.map((e) => e.type === "tool_start" && e.callId)).toEqual(["c1", "c2"])
    const done = events.at(-1)
    expect(done?.type).toBe("done")
    const messages = done?.type === "done" ? done.messages : []
    expect(messages[1]).toEqual({
      role: "assistant",
      content: "Let me echo twice.",
      toolCalls: [call("c1", "echo", { text: "a" }), call("c2", "echo", { text: "b" })],
    })
    expect(
      messages.filter((m) => m.role === "tool").map((m) => m.role === "tool" && m.toolCallId),
    ).toEqual(["c1", "c2"])
    // The second turn replayed the calls and their results, structured.
    expect(seen[1]?.some((m) => m.role === "tool" && m.toolCallId === "c2")).toBe(true)
    // Replayed as history, the next run starts where this one ended.
    const next = scripted([{ kind: "text", text: "ok" }])
    await collect(
      runAgent({
        userMessage: "again",
        tools: [echo],
        llm: next.llm,
        context: ctx,
        history: messages,
      }),
    )
    expect(next.seen[0]?.slice(0, messages.length)).toEqual(messages)
  })

  it("ends with turn_limit, never silently", async () => {
    const { llm } = scripted([
      { kind: "tool_calls", calls: [call("c1", "echo", { text: "a" })] },
      { kind: "tool_calls", calls: [call("c2", "echo", { text: "b" })] },
    ])
    const events = await collect(
      runAgent({ userMessage: "go", tools: [echo], llm, context: { log: [] }, maxTurns: 2 }),
    )
    expect(events.at(-1)).toMatchObject({ type: "turn_limit", maxTurns: 2 })
  })

  it("stops when aborted, answering every pending call (the history stays well-formed)", async () => {
    const controller = new AbortController()
    const stopper = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
      name: "stop",
      description: "Stops the run",
      parameters: z.object({}),
      run: (_args, ctx) => {
        controller.abort()
        return Promise.resolve({ signalled: ctx.signal.aborted })
      },
    })
    const { llm } = scripted([
      {
        kind: "tool_calls",
        calls: [call("c1", "stop", {}), call("c2", "echo", { text: "never" })],
      },
    ])
    const ctx = { log: [] as string[] }
    const events = await collect(
      runAgent({
        userMessage: "go",
        tools: [stopper, echo],
        llm,
        context: ctx,
        signal: controller.signal,
      }),
    )
    expect(ctx.log).toEqual([])
    const end = events.at(-1)
    expect(end?.type).toBe("aborted")
    const messages = end?.type === "aborted" ? end.messages : []
    const results = messages.filter((m) => m.role === "tool")
    expect(results.map((m) => m.role === "tool" && m.toolCallId)).toEqual(["c1", "c2"])
    expect(results[1]?.content).toMatch(/aborted/)
  })

  it("ends with the provider's error, and turns tool failures into results the model reads", async () => {
    const thrower = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
      name: "boom",
      description: "Throws",
      parameters: z.object({}),
      run: () => Promise.reject(new Error("kaput")),
    })
    const { llm } = scripted([
      {
        kind: "tool_calls",
        calls: [call("c1", "boom", {}), call("c2", "nope", {}), call("c3", "echo", { text: 1 })],
      },
      new Error("401 invalid api key"),
    ])
    const events = await collect(
      runAgent({ userMessage: "go", tools: [thrower, echo], llm, context: { log: [] } }),
    )
    const results = events.flatMap((e) => (e.type === "tool_result" ? [e.result] : []))
    expect(results).toMatchObject([
      { ok: false, error: "tool_error" },
      { ok: false, error: "unknown_tool" },
      { ok: false, error: "tool_rejected" },
    ])
    expect(events.at(-1)).toMatchObject({ type: "error", message: "401 invalid api key" })
  })

  it("streams text as it comes, and sends images with this turn only", async () => {
    const llm: LlmClient = {
      complete: () => Promise.reject(new Error("unused")),
      async *completeStream(messages) {
        expect(messages.at(-1)).toMatchObject({ role: "user", images: [{ url: "data:x" }] })
        yield await Promise.resolve({ kind: "delta" as const, text: "Hel" })
        yield { kind: "delta", text: "lo" }
        yield { kind: "final", turn: { kind: "text", text: "Hello" } }
      },
    }
    const events = await collect(
      runAgent({ userMessage: "hi", tools: [], llm, context: {}, images: [{ url: "data:x" }] }),
    )
    const texts = events.flatMap((e) => (e.type === "assistant_text" ? [e.text] : []))
    expect(texts).toEqual(["Hel", "Hello", "Hello"])
    const done = events.at(-1)
    expect(done?.type === "done" && done.messages[0]).toEqual({ role: "user", content: "hi" })
  })
})
