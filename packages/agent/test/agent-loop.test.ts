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
      run: (_args, _ctx, signal) => {
        controller.abort()
        return Promise.resolve({ signalled: signal.aborted })
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

describe("runAgent: review fixes", () => {
  it("turns a result that can't be serialized into an error, and still ends", async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const bad = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
      name: "bad",
      description: "Returns a circular object",
      parameters: z.object({}),
      run: () => Promise.resolve(circular),
    })
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "bad", {})] }])
    const events = await collect(
      runAgent({ userMessage: "go", tools: [bad], llm, context: { log: [] } }),
    )
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      result: { ok: false, error: "tool_error" },
    })
    expect(events.at(-1)?.type).toBe("done")
  })

  it("elides history's old bulky results by recency (never every one sent whole)", async () => {
    const bulky = (id: string): LlmMessage[] => [
      { role: "assistant", content: "", toolCalls: [call(id, "echo", {})] },
      { role: "tool", toolCallId: id, toolName: "echo", content: "x".repeat(9000) },
    ]
    const history = Array.from({ length: 10 }, (_, i) => bulky(`h${i}`)).flat()
    const { llm, seen } = scripted([{ kind: "text", text: "ok" }])
    await collect(
      runAgent({ userMessage: "go", tools: [echo], llm, context: { log: [] }, history }),
    )
    const whole = (seen[0] ?? []).filter((m) => m.role === "tool" && m.content.length > 8000)
    expect(whole.length).toBeLessThanOrEqual(5)
  })

  it("doesn't run a call stopped while its start was being shown", async () => {
    const controller = new AbortController()
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "echo", { text: "a" })] }])
    const ctx = { log: [] as string[] }
    const events: AgentEvent[] = []
    for await (const e of runAgent({
      userMessage: "go",
      tools: [echo],
      llm,
      context: ctx,
      signal: controller.signal,
    })) {
      events.push(e)
      if (e.type === "tool_start") controller.abort()
    }
    expect(ctx.log).toEqual([])
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      result: { error: "aborted" },
    })
    expect(events.at(-1)?.type).toBe("aborted")
  })

  it("gives a stopped tool the aborted result, never a crash to retry", async () => {
    const controller = new AbortController()
    const slow = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
      name: "slow",
      description: "Waits for the stop",
      parameters: z.object({}),
      run: (_a, _c, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("AbortError")))
          controller.abort()
        }),
    })
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "slow", {})] }])
    const events = await collect(
      runAgent({
        userMessage: "go",
        tools: [slow],
        llm,
        context: { log: [] },
        signal: controller.signal,
      }),
    )
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      result: { error: "aborted" },
    })
  })

  it("never runs a cut-off call, stores it replayable, and names calls a provider sent without id", async () => {
    const { llm } = scripted([
      {
        kind: "tool_calls",
        truncated: true,
        calls: [
          { id: "", name: "echo", arguments: '{"text":"a"}' },
          { id: "", name: "echo", arguments: '{"text":"cut' },
        ],
      },
    ])
    const ctx = { log: [] as string[] }
    const events = await collect(runAgent({ userMessage: "go", tools: [echo], llm, context: ctx }))
    expect(ctx.log).toEqual(["a"])
    const done = events.at(-1)
    const messages = done?.type === "done" ? done.messages : []
    const assistant = messages[1]
    const ids = assistant?.role === "assistant" ? (assistant.toolCalls ?? []).map((c) => c.id) : []
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => id !== "")).toBe(true)
    expect(assistant?.role === "assistant" && assistant.toolCalls?.[1]?.arguments).toBe("{}")
    const cut = events.filter((e) => e.type === "tool_result")[1]
    expect(cut).toMatchObject({ result: { ok: false, error: "tool_rejected" } })
    expect(JSON.stringify(cut)).toMatch(/cut off/)
    // Broken JSON the provider didn't cut: said so, never "make it shorter".
    const broken = scripted([
      {
        kind: "tool_calls",
        calls: [call("c9", "echo", { text: "a" }), { id: "c10", name: "echo", arguments: "{oops" }],
      },
    ])
    const again = await collect(
      runAgent({ userMessage: "go", tools: [echo], llm: broken.llm, context: { log: [] } }),
    )
    expect(JSON.stringify(again.filter((e) => e.type === "tool_result")[1])).toMatch(/valid JSON/)
  })

  it("keeps call ids unique across runs, never repeating history's", async () => {
    const first = scripted([
      { kind: "tool_calls", calls: [{ id: "", name: "echo", arguments: '{"text":"a"}' }] },
    ])
    const one = await collect(
      runAgent({ userMessage: "go", tools: [echo], llm: first.llm, context: { log: [] } }),
    )
    const history =
      one.at(-1)?.type === "done" ? (one.at(-1) as { messages: LlmMessage[] }).messages : []
    const second = scripted([
      { kind: "tool_calls", calls: [{ id: "", name: "echo", arguments: '{"text":"b"}' }] },
    ])
    const two = await collect(
      runAgent({
        userMessage: "again",
        tools: [echo],
        llm: second.llm,
        context: { log: [] },
        history,
      }),
    )
    const idsOf = (events: AgentEvent[]) =>
      events.flatMap((e) => (e.type === "tool_start" ? [e.callId] : []))
    expect(idsOf(two).some((id) => idsOf(one).includes(id))).toBe(false)
  })

  it("ends aborted, not done, when the stop comes as the reply arrives; a reply ended early is an error", async () => {
    const controller = new AbortController()
    const llm: LlmClient = {
      complete: () => {
        controller.abort()
        return Promise.resolve({ kind: "text", text: "half an ans" })
      },
    }
    const stopped = await collect(
      runAgent({ userMessage: "go", tools: [], llm, context: {}, signal: controller.signal }),
    )
    expect(stopped.at(-1)?.type).toBe("aborted")
    const early: LlmClient = {
      complete: () => Promise.reject(new Error("unused")),
      async *completeStream() {
        yield await Promise.resolve({ kind: "delta" as const, text: "half" })
      },
    }
    const cut = await collect(runAgent({ userMessage: "go", tools: [], llm: early, context: {} }))
    expect(cut.at(-1)).toMatchObject({ type: "error" })
  })

  it("always ends with an event: a schema that can't become JSON Schema, an odd thrown value", async () => {
    const odd = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
      name: "odd",
      description: "Throws something that can't be printed",
      parameters: z.object({}),
      run: () => {
        const thrown = Object.create(null) as object
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point: a non-Error
        return Promise.reject(thrown)
      },
    })
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "odd", {})] }])
    const events = await collect(
      runAgent({ userMessage: "go", tools: [odd], llm, context: { log: [] } }),
    )
    expect(events.at(-1)?.type).toBe("done")
    const noSchema = {
      name: "x",
      description: "x",
      parameters: z.date(),
      run: () => Promise.resolve(1),
    }
    const bad = await collect(
      runAgent({ userMessage: "go", tools: [noSchema], llm: scripted([]).llm, context: {} }),
    )
    expect(bad.at(-1)?.type).toBe("error")
  })

  it("shows the text sent with tool calls without streaming, and a pending call as it streams", async () => {
    const { llm } = scripted([
      { kind: "tool_calls", text: "Looking first.", calls: [call("c1", "echo", { text: "a" })] },
    ])
    const events = await collect(
      runAgent({ userMessage: "go", tools: [echo], llm, context: { log: [] } }),
    )
    expect(events[0]).toEqual({ type: "assistant_text", text: "Looking first." })
    const streaming: LlmClient = {
      complete: () => Promise.reject(new Error("unused")),
      async *completeStream() {
        yield await Promise.resolve({ kind: "tool_start" as const, name: "echo" })
        yield { kind: "final" as const, turn: { kind: "text" as const, text: "ok" } }
      },
    }
    const streamed = await collect(
      runAgent({ userMessage: "go", tools: [echo], llm: streaming, context: { log: [] } }),
    )
    expect(streamed[0]).toEqual({ type: "tool_pending", toolName: "echo" })
  })

  it("hands tools the host's context as is (a class keeps its methods and private state)", async () => {
    class Host {
      #count = 0
      bump() {
        this.#count += 1
        return this.#count
      }
    }
    const bump = defineTool<Host, z.ZodObject<Record<string, never>>>({
      name: "bump",
      description: "Bumps",
      parameters: z.object({}),
      run: (_a, host) => Promise.resolve({ count: host.bump() }),
    })
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "bump", {})] }])
    const events = await collect(
      runAgent({ userMessage: "go", tools: [bump], llm, context: new Host() }),
    )
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ result: { count: 1 } })
  })

  it("keeps the provider's reasoning state and sends it back on the next turn", async () => {
    const details = [{ type: "reasoning.encrypted", data: "sig" }]
    const { llm, seen } = scripted([
      { kind: "tool_calls", calls: [call("c1", "echo", { text: "a" })], reasoningDetails: details },
      { kind: "text", text: "ok" },
    ])
    await collect(runAgent({ userMessage: "go", tools: [echo], llm, context: { log: [] } }))
    const assistant = seen[1]?.find((m) => m.role === "assistant")
    expect(assistant?.role === "assistant" && assistant.reasoningDetails).toEqual(details)
  })
})

describe("runAgent: round 3", () => {
  it("ends aborted at once when stopped, even if the tool ignores its signal", async () => {
    const controller = new AbortController()
    const deaf = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
      name: "wait",
      description: "Waits for an answer that never comes",
      parameters: z.object({}),
      run: () => {
        setTimeout(() => controller.abort(), 10)
        return new Promise(() => undefined)
      },
    })
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "wait", {})] }])
    const left: Promise<void>[] = []
    const events = await collect(
      runAgent({
        userMessage: "go",
        tools: [deaf],
        llm,
        context: { log: [] },
        signal: controller.signal,
        onLeftBehind: (settled) => left.push(settled),
      }),
    )
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      result: { error: "aborted" },
    })
    expect(events.at(-1)?.type).toBe("aborted")
    // The host is told a tool is still running (its next run waits for it).
    expect(left).toHaveLength(1)
  })

  it("tells the host of a tool left running before the end event, and settles when the tool does", async () => {
    const controller = new AbortController()
    let finish: () => void = () => undefined
    const deaf = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
      name: "wait",
      description: "Finishes only when told",
      parameters: z.object({}),
      run: () => {
        setTimeout(() => controller.abort(), 5)
        return new Promise<{ ok: true }>((resolve) => {
          finish = () => resolve({ ok: true })
        })
      },
    })
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "wait", {})] }])
    let settled: Promise<void> | undefined
    const seenAtEnd: boolean[] = []
    for await (const e of runAgent({
      userMessage: "go",
      tools: [deaf],
      llm,
      context: { log: [] },
      signal: controller.signal,
      onLeftBehind: (s) => {
        settled = s
      },
    })) {
      if (e.type === "aborted") seenAtEnd.push(settled !== undefined)
    }
    expect(seenAtEnd).toEqual([true])
    let resolved = false
    void settled?.then(() => (resolved = true))
    await Promise.resolve()
    expect(resolved).toBe(false)
    finish()
    await settled
    expect(resolved).toBe(true)
  })

  it("doesn't report a tool that heeded the stop", async () => {
    const controller = new AbortController()
    const polite = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
      name: "polite",
      description: "Stops when asked",
      parameters: z.object({}),
      run: (_a, _c, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("stopped")))
          controller.abort()
        }),
    })
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "polite", {})] }])
    let reported = false
    await collect(
      runAgent({
        userMessage: "go",
        tools: [polite],
        llm,
        context: { log: [] },
        signal: controller.signal,
        onLeftBehind: () => (reported = true),
      }),
    )
    expect(reported).toBe(false)
  })

  it("stores a result before showing it (a host throwing at it never makes a run call look unrun)", async () => {
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "echo", { text: "a" })] }])
    const ctx = { log: [] as string[] }
    const run = runAgent({ userMessage: "go", tools: [echo], llm, context: ctx })
    let end: AgentEvent | undefined
    for (let next = await run.next(); !next.done;) {
      if (next.value.type === "tool_result") {
        next = await run.throw(new Error("ipc failed"))
        continue
      }
      end = next.value
      next = await run.next()
    }
    const results = end?.type === "error" ? end.messages.filter((m) => m.role === "tool") : []
    expect(results).toHaveLength(1)
    expect(results[0]?.content).toMatch(/echoed/)
  })

  it("ends at the stop even when the model client ignores its signal", async () => {
    const controller = new AbortController()
    const deafLlm: LlmClient = {
      complete: () => {
        setTimeout(() => controller.abort(), 5)
        return new Promise(() => undefined)
      },
    }
    const events = await collect(
      runAgent({
        userMessage: "go",
        tools: [],
        llm: deafLlm,
        context: {},
        signal: controller.signal,
      }),
    )
    expect(events.at(-1)?.type).toBe("aborted")
  })

  it("gives a call its result when the run ends in error mid-turn (the history stays replayable)", async () => {
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "echo", { text: "a" })] }])
    const run = runAgent({ userMessage: "go", tools: [echo], llm, context: { log: [] } })
    let end: AgentEvent | undefined
    for (let next = await run.next(); !next.done;) {
      const e = next.value
      if (e.type === "tool_start") {
        next = await run.throw(new Error("the host failed"))
        continue
      }
      end = e
      next = await run.next()
    }
    expect(end?.type).toBe("error")
    const messages = end?.type === "error" ? end.messages : []
    expect(
      messages.filter((m) => m.role === "tool").map((m) => m.role === "tool" && m.toolCallId),
    ).toEqual(["c1"])
    // Not run: never "failed, retry" (it didn't start).
    expect(JSON.stringify(messages.at(-1))).toMatch(/didn't run/)
  })

  it("never yields a second end when the host throws into the end event", async () => {
    const { llm } = scripted([{ kind: "text", text: "ok" }])
    const run = runAgent({ userMessage: "go", tools: [], llm, context: {} })
    let next = await run.next()
    while (!next.done && next.value.type !== "done") next = await run.next()
    await expect(run.throw(new Error("store failed"))).rejects.toThrow(/store failed/)
  })

  it("treats an upstream failure mid-reply as an error, never a complete turn", async () => {
    const { assembleStreamedTurn } = await import("../src/stream-assemble.ts")
    async function* chunks() {
      yield await Promise.resolve({ choices: [{ index: 0, delta: { content: "Half" } }] })
      yield {
        error: { message: "upstream 502" },
        choices: [{ index: 0, delta: {}, finish_reason: "error" }],
      }
    }
    await expect(async () => {
      for await (const ev of assembleStreamedTurn(chunks() as never)) void ev
    }).rejects.toThrow(/ended before it was complete/)
  })

  it("keeps the provider's call ids (a thought signature is bound to them), the pending one included", async () => {
    const llm: LlmClient = {
      complete: () => Promise.reject(new Error("unused")),
      async *completeStream() {
        yield await Promise.resolve({ kind: "tool_start" as const, name: "echo", id: "toolu_1" })
        yield {
          kind: "final" as const,
          turn: { kind: "tool_calls" as const, calls: [call("toolu_1", "echo", { text: "a" })] },
        }
      },
    }
    const events = await collect(
      runAgent({ userMessage: "go", tools: [echo], llm, context: { log: [] }, maxTurns: 1 }),
    )
    expect(events[0]).toEqual({ type: "tool_pending", toolName: "echo", callId: "toolu_1" })
    expect(events.find((e) => e.type === "tool_start")).toMatchObject({ callId: "toolu_1" })
  })
})

describe("runAgent: round 6", () => {
  it("keeps the provider's message for an upstream failure mid-stream, through the real SDK", async () => {
    const { OpenAiCompatibleClient } = await import("../src/llm-client.ts")
    const sse = [
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "Half" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ error: { message: "upstream 502", code: 502 }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n")
    const fetch = () =>
      Promise.resolve(new Response(sse, { headers: { "content-type": "text/event-stream" } }))
    const llm = OpenAiCompatibleClient.fromConfig({ apiKey: "k", model: "m", maxRetries: 0, fetch })
    const events = await collect(runAgent({ userMessage: "go", tools: [], llm, context: {} }))
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringMatching(/upstream 502/) as unknown,
    })
  })

  it("ends at the stop when a streaming client ignores its signal, and closes the stream", async () => {
    const controller = new AbortController()
    let closed = false
    const llm: LlmClient = {
      complete: () => Promise.reject(new Error("unused")),
      completeStream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            setTimeout(() => controller.abort(), 5)
            return new Promise<IteratorResult<never>>(() => undefined)
          },
          return: () => {
            closed = true
            return Promise.resolve({ done: true as const, value: undefined })
          },
        }),
      }),
    }
    const events = await collect(
      runAgent({ userMessage: "go", tools: [], llm, context: {}, signal: controller.signal }),
    )
    expect(events.at(-1)?.type).toBe("aborted")
    expect(closed).toBe(true)
  })

  it("leaves no unhandled rejection when stopped while an event is handled", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", onUnhandled)
    try {
      const controller = new AbortController()
      const llm: LlmClient = {
        complete: () => Promise.reject(new Error("unused")),
        async *completeStream() {
          yield await Promise.resolve({ kind: "delta" as const, text: "Hi" })
          throw new Error("cut short by abort")
        },
      }
      for await (const e of runAgent({
        userMessage: "go",
        tools: [],
        llm,
        context: {},
        signal: controller.signal,
      })) {
        if (e.type === "assistant_text") controller.abort()
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  it("keeps the real result of a tool that finishes after the stop, within the grace period", async () => {
    const controller = new AbortController()
    const finishing = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
      name: "record",
      description: "Finalizes on stop",
      parameters: z.object({}),
      run: (_a, _c, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () =>
            setTimeout(() => resolve({ take: "t-1", stopped: true }), 50),
          )
          controller.abort()
        }),
    })
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "record", {})] }])
    let reported = false
    const events = await collect(
      runAgent({
        userMessage: "go",
        tools: [finishing],
        llm,
        context: { log: [] },
        signal: controller.signal,
        onLeftBehind: () => (reported = true),
      }),
    )
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ result: { take: "t-1" } })
    expect(reported).toBe(false)
  })

  it("never lets the host's onLeftBehind misrecord a call", async () => {
    const controller = new AbortController()
    const deaf = defineTool<Ctx, z.ZodObject<Record<string, never>>>({
      name: "wait",
      description: "Never finishes",
      parameters: z.object({}),
      run: () => {
        setTimeout(() => controller.abort(), 5)
        return new Promise(() => undefined)
      },
    })
    const { llm } = scripted([{ kind: "tool_calls", calls: [call("c1", "wait", {})] }])
    const events = await collect(
      runAgent({
        userMessage: "go",
        tools: [deaf],
        llm,
        context: { log: [] },
        signal: controller.signal,
        onLeftBehind: () => {
          throw new Error("host failed")
        },
      }),
    )
    const end = events.at(-1)
    expect(end?.type).toBe("aborted")
    const results = end?.type === "aborted" ? end.messages.filter((m) => m.role === "tool") : []
    expect(results[0]?.content).toMatch(/"aborted"/)
  })
})
