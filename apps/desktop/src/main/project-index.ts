// The projects this app has opened, by id: the folders each was opened from, and the device each
// was on. What the take store's eviction reads a project's named takes from (and whether it
// vanished). Written whole and synced, with a backup of the same content; a file that doesn't read
// is never written over (its backup is read instead; neither reading, both kept aside and the
// index started again). Synchronous (one change at a time). Electron-free.
import { existsSync, readFileSync, realpathSync, renameSync, statSync } from "node:fs"
import { join } from "node:path"
import { jsonText, writeAtomic } from "@kiframe/project"
import type { Folder } from "./folder-inspect.ts"

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
  folders(projectId: string): Folder[] {
    return this.all()[projectId] ?? []
  }

  #change(apply: (all: Index) => void): void {
    let all = this.#read()
    if (all === undefined) {
      // Neither reads: a read error (a moment's I/O trouble) writes nothing; both broken (or one
      // broken, one missing) are kept aside, the last broken copy only, and the index started
      // again (a project not in it keeps every take: nothing lost, never stuck for good).
      const files = [this.#file, `${this.#file}.bak`]
      if (files.some((f) => readState(f) === "unreadable")) return
      for (const file of files) {
        try {
          renameSync(file, `${file}.broken`)
        } catch {
          // not there
        }
      }
      all = {}
    }
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

/** Whether a file can't be read at all (an I/O error), as opposed to missing or not an index. */
function readState(file: string): "unreadable" | "other" {
  try {
    readFileSync(file)
    return "other"
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "other" : "unreadable"
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
    const folders = (entry as unknown[]).flatMap((f): Folder[] => {
      const e = f as Partial<Folder> | null
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
