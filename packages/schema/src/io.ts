import { parseDocument, YAMLParseError } from "yaml"
import * as z from "zod"
import { Composition } from "./composition.ts"
import { OrgSettings, UserPreferences } from "./org.ts"
import { Project, ProjectConfig } from "./project.ts"
import { Scenario } from "./scenario.ts"
import { Scene } from "./scene.ts"
import { migrate, VersionError, type DocumentKind } from "./versioning.ts"

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

/** Migrates (older versions are upgraded, newer ones refused: VersionError), then validates. */
function validate<T extends z.ZodType>(
  schema: T,
  kind: DocumentKind,
  what: string,
  data: unknown,
): z.output<T> {
  let doc: unknown
  try {
    doc = migrate(kind, data).doc
  } catch (error) {
    // A file-level problem like any other: callers handle SchemaError (the message says to update).
    if (error instanceof VersionError) throw new SchemaError(what, error.message)
    throw error
  }
  const result = schema.safeParse(doc)
  if (!result.success) {
    throw new SchemaError(what, z.prettifyError(result.error), result.error.issues)
  }
  return result.data
}

function loadJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    // Not the parser's message: newer engines quote part of the input, which could be anything.
    throw new SchemaError(what, "not valid JSON")
  }
}

/** Parse and validate a scene's `scenario.yaml`. */
export function parseScenarioYaml(text: string): Scenario {
  return validate(Scenario, "scenario", "scenario", loadYaml(text, "scenario"))
}

/** Parse and validate a resolved project config written as YAML (examples, fixtures, scripts). */
export function parseProjectYaml(text: string): ProjectConfig {
  return validate(
    ProjectConfig,
    "project-config",
    "project config",
    loadYaml(text, "project config"),
  )
}

/** Parse and validate a project folder's `project.json`. */
export function parseProjectJson(text: string): Project {
  return validate(Project, "project", "project", loadJson(text, "project"))
}

/** Parse and validate a scene's `scene.json`. */
export function parseSceneJson(text: string): Scene {
  return validate(Scene, "scene", "scene", loadJson(text, "scene"))
}

/** Parse and validate a scene's `composition.json`. */
export function parseCompositionJson(text: string): Composition {
  return validate(Composition, "composition", "composition", loadJson(text, "composition"))
}

/** Parse and validate org settings (as synced from the server). */
export function parseOrgSettingsJson(text: string): OrgSettings {
  return validate(OrgSettings, "org-settings", "org settings", loadJson(text, "org settings"))
}

/** Parse and validate user preferences. */
export function parseUserPreferencesJson(text: string): UserPreferences {
  return validate(
    UserPreferences,
    "user-preferences",
    "user preferences",
    loadJson(text, "user preferences"),
  )
}
