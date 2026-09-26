import { parse as parseYaml } from "yaml"
import * as z from "zod"
import { ProjectConfig } from "./project.ts"
import { Scenario } from "./scenario.ts"

/** Thrown when a file doesn't match its schema. `issues` lists every problem with its path. */
export class SchemaError extends Error {
  readonly issues: readonly z.core.$ZodIssue[]

  constructor(what: string, error: z.ZodError) {
    super(`Invalid ${what}:\n${z.prettifyError(error)}`)
    this.name = "SchemaError"
    this.issues = error.issues
  }
}

function parseWith<T extends z.ZodType>(schema: T, what: string, data: unknown): z.output<T> {
  const result = schema.safeParse(data)
  if (!result.success) throw new SchemaError(what, result.error)
  return result.data
}

/** Parse and validate a scene's `scenario.yaml`. */
export function parseScenarioYaml(text: string): Scenario {
  return parseWith(Scenario, "scenario", parseYaml(text))
}

/** Parse and validate a project config written as YAML (docs examples, fixtures). */
export function parseProjectYaml(text: string): ProjectConfig {
  return parseWith(ProjectConfig, "project config", parseYaml(text))
}
