// The projects this app has opened, by id: the folders each was opened from, the device each was
// on, and since when a folder has been seen gone. What the take store's eviction reads a project's
// named takes from, and how a removed project's takes are found. Written whole and synced, with a
// backup; a file that doesn't read is never written over (the backup is read instead, or nothing
// is written: no project forgotten). Synchronous (one change at a time). Electron-free.
import { copyFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { writeAtomic } from "@kiframe/project"
import type { Folder } from "./folder-inspect.ts"

export interface KnownFolder extends Folder {
  /** When it was first seen gone (cleared when it's there again). */
  missingSince?: number
}

type Index = Record<string, KnownFolder[]>

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
    this.#change((all) => {
      const others = (all[projectId] ?? []).filter((f) => f.path !== path)
      all[projectId] = [...others, { path, ...(dev !== undefined && { dev }) }]
    })
  }

  /** Every known project's folders. */
  all(): Index {
    return this.#read() ?? {}
  }

  /** A project's folders (none: unknown). */
  folders(projectId: string): KnownFolder[] {
    return this.all()[projectId] ?? []
  }

  /** Changes the index as a whole (nothing when it can't be read: never written over). */
  change(apply: (all: Index) => void): void {
    this.#change(apply)
  }

  #change(apply: (all: Index) => void): void {
    const all = this.#read()
    if (all === undefined) return
    apply(all)
    if (existsSync(this.#file)) copyFileSync(this.#file, `${this.#file}.bak`)
    writeAtomic(this.#file, `${JSON.stringify(all, null, 2)}\n`)
  }

  /** The index; undefined when it exists and neither it nor its backup reads (never acted on). */
  #read(): Index | undefined {
    if (!existsSync(this.#file)) return {}
    for (const file of [this.#file, `${this.#file}.bak`]) {
      const parsed = parse(file)
      if (parsed !== undefined) return parsed
    }
    return undefined
  }
}

/** An index file as it reads; a folder or entry that isn't one is left out (never acted on). */
function parse(file: string): Index | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const out: Index = {}
  for (const [id, entry] of Object.entries(raw)) {
    if (!Array.isArray(entry)) continue
    const folders = (entry as unknown[]).flatMap((f): KnownFolder[] => {
      const e = f as Partial<KnownFolder> | null
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

function real(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}
