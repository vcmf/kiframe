import { isAlias, isScalar, parseDocument, visit, YAMLParseError } from "yaml"
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
  const [firstWarning] = doc.warnings
  if (firstWarning) throw new SchemaError(what, firstWarning.message)
  // toJS turns every key into a string: collection keys (`? [a]: 1`) would be stringified, and keys
  // that only differ by YAML type (`1` vs "1", `true` vs "true", or via an alias) would overwrite
  // each other. Reject both instead of silently losing data.
  let problem: string | undefined
  visit(doc, {
    Map(_, map) {
      const seen = new Set<string>()
      for (const pair of map.items) {
        const key = isAlias(pair.key) ? pair.key.resolve(doc) : pair.key
        if (key !== null && key !== undefined && !isScalar(key)) {
          problem = "keys must be plain values, not lists or maps"
          return visit.BREAK
        }
        // Same key string as toJS produces: a null key (`~:`) becomes "".
        const raw = isScalar(key) ? key.value : key
        const name =
          raw === null || raw === undefined
            ? ""
            : typeof raw === "string"
              ? raw
              : JSON.stringify(raw)
        if (seen.has(name)) {
          problem = `duplicate key "${name}"`
          return visit.BREAK
        }
        seen.add(name)
      }
      return undefined
    },
  })
  if (problem !== undefined) throw new SchemaError(what, problem)
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
