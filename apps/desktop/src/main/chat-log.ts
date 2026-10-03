// The chat as the window shows it, folded from the agent's events (pure: tested without the app).
// Each change gives back the items that changed; the window replaces them by id.
import { randomBytes } from "node:crypto"
import { type AgentEvent, isToolFailure, isToolSoftError } from "@kiframe/agent"
import { stepOutcome } from "@kiframe/studio"
import type { ChatItem, ChatRequest } from "../shared/ipc.ts"

const LINE_MAX = 160

/** One line, at most `LINE_MAX` characters. */
export function oneLine(text: string): string {
  const chars = [...text.replace(/\s+/g, " ").trim()]
  return chars.length > LINE_MAX ? `${chars.slice(0, LINE_MAX - 1).join("")}…` : chars.join("")
}

/** What a call acts on, in a line: the arguments that say it, in the order the tools take them. */
export function toolDetail(args: unknown): string {
  if (typeof args !== "object" || args === null) return ""
  const a = args as Record<string, unknown>
  const step = a.step
  // The model's arguments: only strings are shown (anything else isn't what it acts on).
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  if (typeof step === "object" && step !== null) {
    const s = step as Record<string, unknown>
    const target = (typeof s.target === "object" && s.target !== null ? s.target : {}) as Record<
      string,
      unknown
    >
    const what = [
      str(s.action) || (s.preset !== undefined ? "preset" : s.ensure !== undefined ? "ensure" : ""),
      str(target.name) || str(target.text) || str(target.selector),
      str(s.url),
      str(s.preset),
    ]
    return oneLine(what.filter((w) => w !== "").join(" "))
  }
  if (Array.isArray(a.steps)) return `${a.steps.length} steps`
  for (const key of ["id", "question", "scene"]) {
    if (typeof a[key] === "string") return oneLine(a[key])
  }
  return ""
}

/** A result's outcome and first line (the studio says failures in words: "failed (…)"). */
export function toolOutcome(
  result: unknown,
  toolName = "",
): {
  status: "ok" | "failed" | "stopped"
  result: string
} {
  if (isToolFailure(result)) {
    return {
      status: result.error === "aborted" ? "stopped" : "failed",
      result: oneLine(result.message),
    }
  }
  if (isToolSoftError(result)) return { status: "failed", result: oneLine(result.error) }
  const text = typeof result === "string" ? result : (JSON.stringify(result) ?? "")
  // run_steps: a numbered line per step, read as the studio reads one (a step that left the
  // app's site stopped the rest: failed too).
  if (toolName === "run_steps") {
    const numbered = text.split("\n").filter((l) => /^\d+\. /.test(l))
    const bad = numbered.find((l) => stepOutcome(l.replace(/^\d+\. /, "")) !== "ok")
    if (bad !== undefined) return { status: "failed", result: oneLine(bad) }
    if (numbered.length > 0) {
      return { status: "ok", result: oneLine(`${numbered.length} ok; ${numbered.at(-1) ?? ""}`) }
    }
  }
  const failed = /^(failed|invalid|refused|replay failed|recording failed|no scene)\b/.test(text)
  return { status: failed ? "failed" : "ok", result: oneLine(text.split("\n")[0] ?? "") }
}

export class ChatLog {
  readonly items: ChatItem[] = []
  /** This log's own prefix: its ids never meet another project's (the window keys items by id). */
  readonly #prefix = randomBytes(4).toString("hex")
  #next = 0
  /**
   * The item of each call still going, by its provider id (a provider may reuse an id in a later
   * turn: that call gets its own row, never the earlier one's).
   */
  readonly #calls = new Map<string, string>()
  /** The assistant item text goes into, until a tool or the run's end starts a new one. */
  #assistant: string | undefined

  #id(prefix: string): string {
    this.#next += 1
    return `${prefix}-${this.#prefix}-${this.#next}`
  }

  #put(item: ChatItem): ChatItem {
    const at = this.items.findIndex((i) => i.id === item.id)
    if (at === -1) this.items.push(item)
    else this.items[at] = item
    return item
  }

  user(text: string): ChatItem {
    this.#assistant = undefined
    return this.#put({ kind: "user", id: this.#id("user"), text })
  }

  /** A request the agent made: open until answered or closed. */
  request(request: ChatRequest): ChatItem {
    this.#assistant = undefined
    return this.#put({ kind: "request", id: this.#id("request"), request, state: "open" })
  }

  /** An answered request's answer changed after the fact (a grant that couldn't be stored). */
  revise(id: string, answer: string | boolean): ChatItem | undefined {
    const item = this.items.find((i) => i.id === id)
    if (item?.kind !== "request" || item.state !== "answered") return undefined
    return this.#put({ ...item, answer })
  }

  /** The request's end: answered (with the answer) or closed by the stop. */
  settle(id: string, end: { answer: string | boolean } | "closed"): ChatItem | undefined {
    const item = this.items.find((i) => i.id === id)
    if (item?.kind !== "request" || item.state !== "open") return undefined
    // A secret's screenshot goes with the question (kept, it would sit in the chat for good).
    const request =
      item.request.kind === "approve-secret"
        ? (({ shot: _shot, ...rest }) => rest)(item.request)
        : item.request
    return this.#put(
      end === "closed"
        ? { ...item, request, state: "closed" }
        : { ...item, request, state: "answered", answer: end.answer },
    )
  }

  /** Folds one agent event: the items it changed. */
  event(event: AgentEvent): ChatItem[] {
    switch (event.type) {
      case "assistant_text": {
        // The turn's whole text so far (it replaces what was shown).
        if (event.text === "") return []
        this.#assistant ??= this.#id("assistant")
        return [this.#put({ kind: "assistant", id: this.#assistant, text: event.text })]
      }
      case "reasoning":
      case "tool_pending":
        return []
      case "tool_start": {
        this.#assistant = undefined
        const id = this.#id("tool")
        this.#calls.set(event.callId, id)
        return [
          this.#put({
            kind: "tool",
            id,
            name: event.toolName,
            detail: toolDetail(event.args),
            status: "running",
          }),
        ]
      }
      case "tool_result": {
        const id = this.#calls.get(event.callId) ?? this.#id("tool")
        this.#calls.delete(event.callId)
        const item = this.items.find((i) => i.id === id)
        const base =
          item?.kind === "tool"
            ? item
            : { kind: "tool" as const, id, name: event.toolName, detail: "" }
        return [this.#put({ ...base, ...toolOutcome(event.result, event.toolName) })]
      }
      default: {
        this.#assistant = undefined
        this.#calls.clear()
        // The run's end: a call still shown running didn't finish (the run stopped or failed).
        const changed: ChatItem[] = []
        for (const item of this.items) {
          if (item.kind === "tool" && item.status === "running") {
            changed.push(this.#put({ ...item, status: "stopped" }))
          }
        }
        const outcome =
          event.type === "aborted"
            ? "stopped"
            : event.type === "turn_limit"
              ? "turn_limit"
              : event.type
        const message =
          event.type === "error"
            ? oneLine(event.message)
            : event.type === "turn_limit"
              ? `stopped after ${event.maxTurns} turns`
              : event.type === "done" && event.truncated === true
                ? "the answer was cut short (the model's length limit)"
                : undefined
        changed.push(
          this.#put({
            kind: "end",
            id: this.#id("end"),
            outcome,
            ...(message !== undefined && { message }),
          }),
        )
        return changed
      }
    }
  }
}
