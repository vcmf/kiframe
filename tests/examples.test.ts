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

// A recording knows its secrets from the login on (SECRETS-DESIGN §3 A8), and hide rules always
// follow the grammar: every CSS selector in an example's parsed config (targets, fallbacks,
// `within`, conditions, interrupt `when`s, hide rules) must fit, or the scene fails at that step.
function cssSelectors(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => cssSelectors(v, out))
  else if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>
    if (o.by === "css" && typeof o.selector === "string") out.push(o.selector)
    Object.values(o).forEach((v) => cssSelectors(v, out))
  }
  return out
}

describe("examples' CSS selectors", () => {
  const selectors = files.flatMap((file) => {
    const text = readFileSync(file, "utf8")
    const parsed = file.endsWith("project.yaml") ? parseProjectYaml(text) : parseScenarioYaml(text)
    const hide = "hide" in parsed ? parsed.hide : []
    return [...cssSelectors(parsed), ...hide].map((selector) => ({ file, selector }))
  })
  it.each(selectors)("$selector ($file) fits the A8 grammar", ({ selector }) => {
    expect(isSafeSelector(selector)).toBe(true)
  })
})
