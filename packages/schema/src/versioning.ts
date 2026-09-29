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

/** The versions this Kiframe writes, and the migrations it knows. */
export const MIGRATIONS: MigrationRegistry = {
  current: {
    project: 1,
    "project-config": 1,
    scene: 1,
    scenario: 1,
    composition: 2,
    "org-settings": 1,
    "user-preferences": 1,
  },
  migrations: {
    composition: {
      // Secret masks left the composition (drawn from the take at render time, SECRETS-DESIGN I4).
      1: (doc) => {
        const tracks = (doc.tracks ?? {}) as Record<string, unknown>
        if (!Array.isArray(tracks.masks)) return { ...doc }
        const kept = (tracks.masks as unknown[]).filter((m) => {
          const { target, kind, id } = (m ?? {}) as {
            target?: unknown
            kind?: unknown
            id?: unknown
          }
          if (!(typeof target === "object" && target !== null && "sensitiveId" in target))
            return true
          // A blur of a secret region: the take draws it now. Anything else on one can't be kept.
          if (kind === "blur" || kind === "pixelate") return false
          throw new VersionError(
            `mask "${String(id)}" (${String(kind)}) points at a secret region, which compositions can't do any more: remove it`,
          )
        })
        return { ...doc, tracks: { ...tracks, masks: kept } }
      },
    },
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
