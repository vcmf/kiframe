import { describe, expect, it } from "vitest"
import { AgentTrace } from "../src/main/trace.ts"

describe("the agent's trace", () => {
  it("writes each stretch of thinking and of answer once, whole, timed; tools with their args", () => {
    const lines: string[] = []
    const trace = new AgentTrace((l) => lines.push(l))
    // Each streamed event holds the whole text so far.
    trace.event({ type: "reasoning", text: "Where" }, 1000)
    trace.event({ type: "reasoning", text: "Where is the view?" }, 4000)
    trace.event({ type: "assistant_text", text: "Let me" }, 5000)
    trace.event({ type: "assistant_text", text: "Let me look." }, 5100)
    trace.event(
      { type: "tool_start", callId: "c1", toolName: "snapshot", args: { find: "2026" } },
      5200,
    )
    trace.event({ type: "tool_result", callId: "c1", toolName: "snapshot", result: "url: /" }, 5800)
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([
      { type: "thought", t: 1000, text: "Where is the view?", ms: 4000 },
      { type: "said", t: 5000, text: "Let me look.", ms: 200 },
      { t: 5200, type: "tool_start", tool: "snapshot", args: { find: "2026" } },
      { t: 5800, type: "tool_result", tool: "snapshot", result: '"url: /"' },
    ])
    expect(lines.every((l) => l.endsWith("\n") && !l.slice(0, -1).includes("\n"))).toBe(true)
  })

  it("writes a thought that resumes in the same reply as what came since; the last one at the end", () => {
    const lines: string[] = []
    const trace = new AgentTrace((l) => lines.push(l))
    trace.event({ type: "reasoning", text: "First." }, 0)
    trace.event({ type: "assistant_text", text: "Hm." }, 10)
    trace.event({ type: "reasoning", text: "First. Second." }, 20)
    trace.flush(50)
    expect(lines.map((l) => (JSON.parse(l) as { text: string }).text)).toEqual([
      "First.",
      "Hm.",
      " Second.",
    ])
  })

  it("stops tracing when it can't write, never failing the run", () => {
    let calls = 0
    const trace = new AgentTrace(() => {
      calls++
      throw new Error("ENOENT")
    })
    trace.event({ type: "tool_start", callId: "c", toolName: "snapshot", args: {} })
    trace.event({ type: "tool_result", callId: "c", toolName: "snapshot", result: "" })
    expect(calls).toBe(1)
  })

  it("traces nothing without a file", () => {
    expect(AgentTrace.fromEnv(undefined)).toBeUndefined()
    expect(AgentTrace.fromEnv("")).toBeUndefined()
  })
})
