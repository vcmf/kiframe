import { isScalar, parseDocument, visit, YAMLParseError } from "yaml"
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

/** Keys that would change an object's prototype instead of creating a property. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"])

function loadYaml(text: string, what: string): unknown {
  const doc = parseDocument(text)
  const [firstError] = doc.errors
  if (firstError) throw new SchemaError(what, firstError.message)
  let forbidden: string | undefined
  visit(doc, {
    Pair(_, pair) {
      if (
        isScalar(pair.key) &&
        typeof pair.key.value === "string" &&
        FORBIDDEN_KEYS.has(pair.key.value)
      ) {
        forbidden = pair.key.value
        return visit.BREAK
      }
      return undefined
    },
  })
  if (forbidden !== undefined) throw new SchemaError(what, `forbidden key "${forbidden}"`)
  try {
    return doc.toJS()
  } catch (error) {
    if (error instanceof YAMLParseError) throw new SchemaError(what, error.message)
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
