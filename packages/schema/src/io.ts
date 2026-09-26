import { parseDocument, YAMLParseError } from "yaml"
import * as z from "zod"
import { ProjectConfig } from "./project.ts"
import { Scenario } from "./scenario.ts"

/** Thrown when a file isn't valid YAML or doesn't match its schema. `issues` lists schema problems. */
export class SchemaError extends Error {
  readonly issues: readonly z.core.$ZodIssue[]

  constructor(what: string, detail: string, issues: readonly z.core.$ZodIssue[] = []) {
    super(`Invalid ${what}:\n${detail}`)
    this.name = "SchemaError"
    this.issues = issues
  }
}

function loadYaml(text: string, what: string): unknown {
  const doc = parseDocument(text)
  const [firstError] = doc.errors
  if (firstError) throw new SchemaError(what, firstError.message)
  try {
    // maxAliasCount guards against "billion laughs" alias expansion. Forbidden keys such as
    // `__proto__` stay own keys in the output and are rejected by the schema guards.
    return doc.toJS({ maxAliasCount: 100 })
  } catch (error) {
    // yaml throws ReferenceError for unresolved or excessive aliases, YAMLParseError otherwise.
    if (error instanceof YAMLParseError || error instanceof ReferenceError) {
      throw new SchemaError(what, error.message)
    }
    throw error
  }
}

function parseWith<T extends z.ZodType>(schema: T, what: string, text: string): z.output<T> {
  const data = loadYaml(text, what)
  const result = schema.safeParse(data)
  if (!result.success) {
    throw new SchemaError(what, z.prettifyError(result.error), result.error.issues)
  }
  return result.data
}

/** Parse and validate a scene's `scenario.yaml`. */
export function parseScenarioYaml(text: string): Scenario {
  return parseWith(Scenario, "scenario", text)
}

/** Parse and validate a project config written as YAML (docs examples, fixtures). */
export function parseProjectYaml(text: string): ProjectConfig {
  return parseWith(ProjectConfig, "project config", text)
}
