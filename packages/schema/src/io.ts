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
  // stringKeys: every key keeps its source text, so keys can't collide once converted (`1` vs "1",
  // `.nan` vs `NaN`), and yaml itself reports duplicate, collection and alias keys as errors.
  // prettyErrors: false keeps the offending source line (possibly a mistyped secret) out of errors.
  const doc = parseDocument(text, { stringKeys: true, prettyErrors: false })
  const [firstError] = doc.errors
  if (firstError) throw new SchemaError(what, `${firstError.code}: ${firstError.message}`)
  const [firstWarning] = doc.warnings
  if (firstWarning) throw new SchemaError(what, `${firstWarning.code}: ${firstWarning.message}`)
  // A `%YAML 1.1` directive would switch to 1.1 rules (yes/no booleans, `<<` merge keys…).
  if (doc.directives.yaml.version !== "1.2") {
    throw new SchemaError(what, "only YAML 1.2 is supported (remove the %YAML directive)")
  }
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
