// The projects this app has opened, by id, and the folders it saw each in (with the device each
// was on). A folder is gone only when the filesystem it was on is still mounted where it was (the
// nearest folder above it is on that device) and it isn't there: an unplugged drive or share,
// its root included, never is. Gone for 7 days: a copy's pins go (the project elsewhere), or, every
// folder gone, the project's takes go (decided by the user, 2026-10-04). Reopening it before, from
// wherever it is, keeps them. Electron-free.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { type TakeStore, writeAtomic } from "@kiframe/project"

/** How long a folder stays gone before its pins, or its project's takes, go. */
export const REMOVED_AFTER_MS = 7 * 24 * 60 * 60 * 1000

interface Folder {
  path: string
  /** The device it was on when opened (unknown: never counted gone). */
  dev?: number
  /** When it was first seen gone (cleared when it's back). */
  missingSince?: number
}

type Index = Record<string, Folder[]>

export class ProjectIndex {
  readonly #file: string

  constructor(dataDir: string) {
    this.#file = join(dataDir, "projects.json")
  }

  /** A project opened from a folder: known there (resolved), on its device, not missing. */
  seen(projectId: string, dir: string): void {
    const path = real(dir)
    let dev: number | undefined
    try {
      dev = statSync(path).dev
    } catch {
      dev = undefined
    }
    const all = this.#read()
    const others = (all[projectId] ?? []).filter((f) => f.path !== path)
    all[projectId] = [...others, { path, ...(dev !== undefined && { dev }) }]
    this.#write(all)
  }

  /** The folders each known project was opened from (to sync their pins at start). */
  known(): { id: string; dirs: string[] }[] {
    return Object.entries(this.#read()).map(([id, folders]) => ({
      id,
      dirs: folders.map((f) => f.path),
    }))
  }

  /**
   * At the app's start: a folder gone 7 days loses its copy's pins (the project still elsewhere);
   * a project whose every folder is gone 7 days has its takes removed (the ids).
   */
  sweepRemoved(takes: TakeStore, now = Date.now()): string[] {
    const all = this.#read()
    const removed: string[] = []
    for (const [id, folders] of Object.entries(all)) {
      const marked = folders.map((f) =>
        isGone(f) ? { ...f, missingSince: f.missingSince ?? now } : withoutMissing(f),
      )
      const due = marked.filter(
        (f) => f.missingSince !== undefined && now - f.missingSince >= REMOVED_AFTER_MS,
      )
      if (marked.length > 0 && due.length === marked.length) {
        takes.removeProject(id)
        delete all[id]
        removed.push(id)
        continue
      }
      for (const f of due) takes.forgetCopy(id, f.path)
      all[id] = marked.filter((f) => !due.includes(f))
    }
    this.#write(all)
    return removed
  }

  /** The index as read; an entry or folder that doesn't read as one is left out (never acted on). */
  #read(): Index {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.#file, "utf8"))
    } catch {
      return {}
    }
    if (typeof parsed !== "object" || parsed === null) return {}
    const out: Index = {}
    for (const [id, raw] of Object.entries(parsed)) {
      if (!Array.isArray(raw)) continue
      const folders = (raw as unknown[]).flatMap((f): Folder[] => {
        const e = f as Partial<Folder> | null
        if (e === null || typeof e !== "object" || typeof e.path !== "string") return []
        return [
          {
            path: e.path,
            ...(typeof e.dev === "number" && { dev: e.dev }),
            ...(typeof e.missingSince === "number" && { missingSince: e.missingSince }),
          },
        ]
      })
      if (folders.length > 0) out[id] = folders
    }
    return out
  }

  #write(all: Index): void {
    writeAtomic(this.#file, `${JSON.stringify(all, null, 2)}\n`, 0o600)
  }
}

/**
 * Gone: no project.json there, while the nearest folder above it exists on the device the project
 * was on (its filesystem mounted where it was). Unknown device: never gone.
 */
function isGone(folder: Folder): boolean {
  if (folder.dev === undefined || existsSync(join(folder.path, "project.json"))) return false
  for (let at = dirname(folder.path); ; at = dirname(at)) {
    try {
      return statSync(at).dev === folder.dev
    } catch {
      if (dirname(at) === at) return false
    }
  }
}

function withoutMissing(folder: Folder): Folder {
  const { missingSince: _missing, ...rest } = folder
  return rest
}

function real(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}
