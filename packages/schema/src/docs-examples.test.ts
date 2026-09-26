import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { InterruptRule, parseProjectYaml, parseScenarioYaml } from "./index.ts"

// The YAML examples in docs/OBJECT-MODEL.md must stay valid: this test reads them straight from the doc.
const doc = readFileSync(join(import.meta.dirname, "../../../docs/OBJECT-MODEL.md"), "utf8")

/** Returns the first ```yaml block that follows `marker` in the doc. */
function yamlBlockAfter(marker: string): string {
  const start = doc.indexOf(marker)
  if (start === -1) throw new Error(`marker not found in OBJECT-MODEL.md: ${marker}`)
  const match = /```yaml\n([\s\S]*?)```/.exec(doc.slice(start))
  if (!match?.[1]) throw new Error(`no yaml block after: ${marker}`)
  return match[1]
}

describe("docs/OBJECT-MODEL.md examples", () => {
  it("project-level example (§2) is a valid project config", () => {
    const project = parseProjectYaml(yamlBlockAfter("**Project level**"))
    expect(project.target.url).toBe("https://staging.acme.com")
    expect(project.presets["login-as-manager"]?.session).toBe(true)
    expect(project.defaults.pacing.settleMs).toBe(400)
  })

  it("scene-level example (§2) is a valid scenario", () => {
    const scenario = parseScenarioYaml(yamlBlockAfter("**Scene level**"))
    expect(scenario.steps.map((s) => s.id)).toEqual(["open-new", "name-project", "done"])
    expect(scenario.setup).toHaveLength(3)
    expect(scenario.teardown?.[1]?.risky).toBe(true)
  })

  it("interrupts example (§2b) is a valid list of interrupt rules", () => {
    const data = parseYaml(yamlBlockAfter("Two project-level mechanisms")) as {
      interrupts: unknown
    }
    expect(() => z.array(InterruptRule).parse(data.interrupts)).not.toThrow()
  })
})
