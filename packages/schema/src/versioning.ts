// Document versions and migrations. Every stored document has a `version`. When a schema changes
// incompatibly, its version goes up and a migration from the previous version is registered here:
// older documents are upgraded on read, one version at a time, before validation. A document from
// a newer Kiframe is refused with a clear message (never guessed at, never rewritten).
// Versions count from the first release: pre-release changes (no user has files yet) stay at 1.

export type DocumentKind =
  | "project"
  | "project-config"
  | "scene"
  | "scenario"
  | "composition"
  | "org-settings"
  | "user-preferences"

/**
 * Upgrades a document from version `n` (the key) to `n + 1`. Must not mutate its input, and must
 * not walk it recursively: it runs on raw input, before the schema's guards (depth, forbidden keys).
 */
export type Migration = (doc: Readonly<Record<string, unknown>>) => Record<string, unknown>

export interface MigrationRegistry {
  current: Record<DocumentKind, number>
  migrations: Partial<Record<DocumentKind, Record<number, Migration>>>
}

/**
 * Project 1 → 2 (OBJECT-MODEL §0.9): its one `target` becomes the first of its named apps,
 * `apps.app`. A project that took its URL from an org environment has no URL to carry over:
 * refused with what to do (environments no longer give URLs), never a guess. Anything malformed
 * is passed on for the schema to report.
 */
function targetToApps(project: boolean): Migration {
  return (doc) => {
    const { target, ...rest } = doc
    // An environment first, whatever its target looks like: the message says what to do.
    if (project && "environment" in doc && !("apps" in doc)) {
      const name = typeof doc.environment === "string" ? `"${doc.environment}"` : "of the org"
      throw new VersionError(
        `this project takes its app's address from the environment ${name}; Kiframe now keeps each app's address in the project: replace "environment" and "target" with "apps": { "app": { "kind": "web", "url": "https://…" } }`,
      )
    }
    if (typeof target !== "object" || target === null || Array.isArray(target) || "apps" in doc) {
      return { ...doc }
    }
    // A resolved config's environment only named where its URL came from: the URL is kept.
    const { environment: _named, ...kept } = rest
    // `target` as it is (never walked: the guards still see every key in it).
    return { ...(project ? rest : kept), apps: { app: target } }
  }
}

/** The versions this Kiframe writes, and the migrations it knows. */
export const MIGRATIONS: MigrationRegistry = {
  current: {
    project: 2,
    "project-config": 2,
    scene: 1,
    scenario: 1,
    composition: 1,
    "org-settings": 1,
    "user-preferences": 1,
  },
  migrations: {
    project: { 1: targetToApps(true) },
    "project-config": { 1: targetToApps(false) },
  },
}

const LABELS: Record<DocumentKind, string> = {
  project: "project",
  "project-config": "project config",
  scene: "scene",
  scenario: "scenario",
  composition: "composition",
  "org-settings": "org settings",
  "user-preferences": "user preferences",
}

export class VersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VersionError"
  }
}

/**
 * Brings a raw document to the current version of its kind. A document without a usable
 * `version` is returned as is: its schema reports it. `migrated` says whether anything changed
 * (the store can then rewrite the file).
 */
export function migrate(
  kind: DocumentKind,
  doc: unknown,
  registry: MigrationRegistry = MIGRATIONS,
): { doc: unknown; migrated: boolean } {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { doc, migrated: false }
  const version = (doc as { version?: unknown }).version
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { doc, migrated: false }
  }
  const current = registry.current[kind]
  if (version > current) {
    throw new VersionError(
      `made by a newer version of Kiframe (${LABELS[kind]} version ${version}; this one reads up to ${current}): update Kiframe to open it`,
    )
  }
  let out = doc as Record<string, unknown>
  for (let v = version; v < current; v++) {
    const step = registry.migrations[kind]?.[v]
    if (step === undefined) {
      throw new VersionError(`no migration for ${kind} from version ${v} to ${v + 1}`)
    }
    out = { ...step(out), version: v + 1 }
  }
  return { doc: out, migrated: out !== doc }
}
