import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { isSafeSelector } from "@kiframe/runtime"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { describe, expect, it } from "vitest"

// Every example in examples/ stays valid as the schema changes (a secret step without an id broke
// the Cal.com login preset once, unnoticed until a live run).
const root = join(import.meta.dirname, "..", "examples")
const files = readdirSync(root, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".yaml"))
  .map((f) => join(root, f))

describe("examples", () => {
  it("has examples to check", () => expect(files.length).toBeGreaterThan(0))
  it.each(files)("%s parses", (file) => {
    const text = readFileSync(file, "utf8")
    const parse = file.endsWith("project.yaml") ? parseProjectYaml : parseScenarioYaml
    expect(() => parse(text)).not.toThrow()
  })
})

// A recording knows its secrets from the login on (SECRETS-DESIGN §3 A8): every CSS selector in an
// example must fit the grammar, or the scene fails at that step.
describe("examples' CSS selectors", () => {
  const selectors = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/selector:\s*("[^"]*"|'[^']*'|[^,}\n]+)/g)].map(
      (m) => ({
        file,
        selector: (m[1] ?? "").trim().replace(/^["']|["']$/g, ""),
      }),
    ),
  )
  it.each(selectors)("$selector ($file) fits the A8 grammar", ({ selector }) => {
    expect(isSafeSelector(selector)).toBe(true)
  })
})
