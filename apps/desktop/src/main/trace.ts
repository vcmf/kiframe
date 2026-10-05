// The agent's events as lines of JSON, for runs on real apps (scripts/real-apps/drive.ts): what it
// called, with what, and how long it thought, to see where a slow run's time went.
import { appendFileSync } from "node:fs"
import type { AgentEvent } from "@kiframe/agent"

type Streamed = "thought" | "said"

/**
 * One line per event: its time, kind, tool and arguments, the start of a tool's result (results
 * are scrubbed by the studio: no secret's value), and each stretch of thinking and of answer whole,
 * with how long it took. A write that fails turns the trace off: never the user's run.
 */
export class AgentTrace {
  #write: ((line: string) => void) | undefined
  /** The stretch under way: the reply's text so far (`full`), from `from` on its own. */
  #streaming: { type: Streamed; t: number; full: string; from: number } | undefined
  /** The reply's text so far, per kind (each streamed event holds the whole of it). */
  #reply: Record<Streamed, string> = { thought: "", said: "" }

  constructor(write: (line: string) => void) {
    this.#write = write
  }

  /** A trace appended to `file`; none without one. */
  static fromEnv(file: string | undefined): AgentTrace | undefined {
    if (file === undefined || file === "") return undefined
    return new AgentTrace((line) => appendFileSync(file, line))
  }

  event(event: AgentEvent, now = Date.now()): void {
    const kind =
      event.type === "reasoning" ? "thought" : event.type === "assistant_text" ? "said" : undefined
    if (this.#streaming !== undefined && this.#streaming.type !== kind) this.flush(now)
    if (event.type === "reasoning" || event.type === "assistant_text") {
      const type = kind!
      if (this.#streaming === undefined) {
        // A reply that thinks, says, then thinks again: this stretch is what came since.
        const before = this.#reply[type]
        const from = event.text.startsWith(before) ? before.length : 0
        this.#streaming = { type, t: now, full: event.text, from }
      } else this.#streaming.full = event.text
      return
    }
    // A tool call ends the reply: the next one's text starts afresh.
    this.#reply = { thought: "", said: "" }
    this.#line({
      t: now,
      type: event.type,
      ...("toolName" in event && { tool: event.toolName }),
      ...(event.type === "tool_start" && { args: event.args }),
      ...(event.type === "tool_result" && { result: JSON.stringify(event.result).slice(0, 600) }),
      ...(event.type === "error" && { text: event.message }),
    })
  }

  /** Writes the stretch under way (also when the run ends in it). */
  flush(now = Date.now()): void {
    const s = this.#streaming
    if (s === undefined) return
    this.#streaming = undefined
    this.#reply[s.type] = s.full
    this.#line({ type: s.type, t: s.t, ms: now - s.t, text: s.full.slice(s.from) })
  }

  #line(line: object): void {
    try {
      this.#write?.(`${JSON.stringify(line)}\n`)
    } catch {
      // A trace that can't be written (no folder, a full disk) stops: never the user's run.
      this.#write = undefined
    }
  }
}
