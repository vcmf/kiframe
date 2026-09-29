import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readTake } from "../src/take.ts"

describe("readTake", () => {
  it("refuses a take whose secret regions have no spans (recorded before them): re-record", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-take-"))
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ version: 1 }))
    const old = {
      t: 0,
      phase: "setup",
      kind: "sensitive",
      id: "s",
      rect: { x: 0, y: 0, w: 1, h: 1 },
      why: "secret-field",
    }
    writeFileSync(join(dir, "events.jsonl"), JSON.stringify(old) + "\n")
    writeFileSync(join(dir, "cursor.jsonl"), "")
    expect(() => readTake(dir)).toThrow()
  })
})
