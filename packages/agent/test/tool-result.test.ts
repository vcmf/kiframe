import { describe, expect, it } from "vitest"
import {
  isToolFailure,
  isToolSoftError,
  toolRejected,
  toolThrew,
  unknownTool,
  userDeclined,
} from "../src/tool-result.ts"

describe("tool-result contract", () => {
  it("userDeclined names the tool, frames it as a permission choice, scoped to this call", () => {
    const r = userDeclined("web_search")
    expect(r).toMatchObject({ ok: false, error: "user_declined", tool: "web_search" })
    expect(r.message).toContain("web_search")
    expect(r.message.toLowerCase()).toContain("declined")
    expect(r.message.toLowerCase()).toContain("exact call") // per-call, not a tool-wide ban
  })

  it("unknownTool names the missing tool and steers back to valid ones", () => {
    const r = unknownTool("frobnicate")
    expect(r).toMatchObject({ ok: false, error: "unknown_tool", tool: "frobnicate" })
    expect(r.message).toContain("frobnicate")
    expect(r.message).toContain("no tool named")
  })

  it("toolThrew carries the tool name and the underlying error message", () => {
    const r = toolThrew("code_interpreter", new Error("segfault"))
    expect(r).toMatchObject({ ok: false, error: "tool_error", tool: "code_interpreter" })
    expect(r.message).toContain("code_interpreter")
    expect(r.message).toContain("segfault")
  })

  it("toolThrew stringifies a non-Error throw", () => {
    expect(toolThrew("fetch", "raw string").message).toContain("raw string")
  })

  it("isToolFailure is uniform across every failure origin", () => {
    expect(isToolFailure(userDeclined("x"))).toBe(true)
    expect(isToolFailure(unknownTool("x"))).toBe(true)
    expect(isToolFailure(toolThrew("x", new Error("e")))).toBe(true)
    expect(isToolFailure(toolRejected("x", "e"))).toBe(true)
  })

  it("isToolFailure discriminates failures from a tool's own output", () => {
    expect(isToolFailure({ id: "n1", created: true })).toBe(false) // a tool's success output
    expect(isToolFailure({ error: "note not found" })).toBe(false) // a RAW soft error (not yet normalized)
    expect(isToolFailure(null)).toBe(false)
    expect(isToolFailure("declined")).toBe(false)
  })

  it("isToolSoftError recognizes the tool `{ error }` convention only", () => {
    expect(isToolSoftError({ error: "note not found" })).toBe(true)
    expect(isToolSoftError({ error: "" })).toBe(false) // empty isn't a failure signal
    expect(isToolSoftError({ id: "n1", created: true })).toBe(false) // a success output
    expect(isToolSoftError(toolRejected("create_note", "x"))).toBe(false) // already a ToolFailure (has `ok`)
    expect(isToolSoftError(null)).toBe(false)
  })

  it("toolRejected normalizes a tool error into the shared failure shape", () => {
    const r = toolRejected("create_note", "note not found")
    expect(r).toEqual({
      ok: false,
      error: "tool_rejected",
      tool: "create_note",
      message: "note not found",
    })
    expect(isToolFailure(r)).toBe(true) // one uniform "did it fail?" check across all origins
  })
})
