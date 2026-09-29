import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readTake } from "../src/take.ts"

describe("readTake", () => {
  it("refuses a take recorded before secret regions had spans (version 1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-take-"))
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ version: 1 }))
    writeFileSync(join(dir, "events.jsonl"), "")
    writeFileSync(join(dir, "cursor.jsonl"), "")
    expect(() => readTake(dir)).toThrow(
      /take version 1: secret regions without spans\): record it again/,
    )
  })
})
