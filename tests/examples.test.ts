import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
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
