import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { ACTION_REFERENCE, type ActionKind, COMMON_FIELDS, EXAMPLE_LOCATOR } from "./reference.ts"
import { Action, Step } from "./scenario.ts"

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

  it("parses every example of the fields steps take, where it says they go", () => {
    for (const { field, example, offCamera } of COMMON_FIELDS) {
      const item: unknown = parseYaml(example.replaceAll("<locator>", EXAMPLE_LOCATOR))
      if ("id" in (item as object)) {
        expect(Step.safeParse(item).success, `on camera: ${field}`).toBe(true)
      }
      // Off camera (setup, teardown): accepted exactly when it says so.
      expect(Action.safeParse(item).success, `off camera: ${field}`).toBe(offCamera)
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
