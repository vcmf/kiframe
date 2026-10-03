import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { ACTION_REFERENCE, type ActionKind, COMMON_FIELDS, EXAMPLE_LOCATOR } from "./reference.ts"
import { Step } from "./scenario.ts"

const KINDS = Object.keys(ACTION_REFERENCE) as ActionKind[]

describe("the step reference the agent reads", () => {
  // Every action kind has an entry: `Record<ActionKind, …>` makes a missing one a compile error.
  it("names only actions the schema accepts", () => {
    for (const kind of KINDS) {
      const probe = Step.safeParse({ id: "x", action: kind })
      // A known action fails on its fields, never on the action itself.
      const onAction = probe.error?.issues.some(
        (i) => i.path.length === 1 && i.path[0] === "action",
      )
      expect(onAction, kind).toBeFalsy()
    }
    const unknown = Step.safeParse({ id: "x", action: "draw" })
    expect(unknown.error?.issues.some((i) => i.path[0] === "action")).toBe(true)
  })

  it("parses every example of the fields every step takes", () => {
    for (const { field, example } of COMMON_FIELDS) {
      const parsed = Step.safeParse(parseYaml(example.replaceAll("<locator>", EXAMPLE_LOCATOR)))
      expect(parsed.success, `${field}\n${JSON.stringify(parsed.error?.issues)}`).toBe(true)
    }
  })

  it("parses every form it shows, as the agent would write it", () => {
    for (const kind of KINDS) {
      for (const form of ACTION_REFERENCE[kind].forms) {
        const yaml = form.replaceAll("<locator>", EXAMPLE_LOCATOR)
        const parsed = Step.safeParse(parseYaml(yaml))
        expect(parsed.success, `${kind}: ${form}\n${JSON.stringify(parsed.error?.issues)}`).toBe(
          true,
        )
      }
    }
  })
})
