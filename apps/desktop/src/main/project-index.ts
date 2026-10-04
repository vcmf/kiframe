// The projects this app has opened, by id: the folders each was opened from, and the device each
// was on. What the take store's eviction reads a project's named takes from (and whether it
// vanished). Written whole and synced, with a
// backup; a file that doesn't read is never written over (the backup is read instead, or nothing
// is written: no project forgotten). Synchronous (one change at a time). Electron-free.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { jsonText, writeAtomic } from "@kiframe/project"
import type { Folder } from "./folder-inspect.ts"

export type KnownFolder = Folder

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
    // The backup the same (never a change behind: a lost file loses no folder).
    const text = jsonText(all)
    writeAtomic(this.#file, text)
    writeAtomic(`${this.#file}.bak`, text)
  }

  /** The index; undefined when neither it nor its backup reads (never acted on). */
  #read(): Index | undefined {
    const backup = `${this.#file}.bak`
    // Never made: empty. The file lost (deleted, a sync tool) or broken: its backup.
    if (!existsSync(this.#file) && !existsSync(backup)) return {}
    for (const file of [this.#file, backup]) {
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
