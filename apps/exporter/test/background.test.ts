import { existsSync } from "node:fs"
import { basename } from "node:path"
import { BUILTIN_BACKGROUNDS, type BuiltinBackground } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import { backgroundFile } from "../src/background.ts"

describe("the export's background", () => {
  it("is the shipped file of each builtin, none without a background", () => {
    for (const builtin of BUILTIN_BACKGROUNDS) {
      const file = backgroundFile({ builtin })
      expect(file && basename(file)).toBe(`${builtin}.jpg`)
      expect(existsSync(file ?? ""), builtin).toBe(true)
    }
    expect(backgroundFile("none")).toBeUndefined()
    expect(() => backgroundFile({ builtin: "beach" as BuiltinBackground })).toThrow(/beach/)
  })
})
