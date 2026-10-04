// The projects this app has opened, by id, and the folders it saw each in: a project whose every
// folder is gone (the drive there: never an unplugged one) for 7 days is removed, and its takes
// with it (decided by the user, 2026-10-04). Reopening it before, from wherever it is, keeps them.
// And a project's pins, synced with its compositions when it opens (a branch switched meanwhile).
// Electron-free.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { OpenedProject, TakeStore } from "@kiframe/project"

/** How long a project's folders stay gone before its takes go. */
export const REMOVED_AFTER_MS = 7 * 24 * 60 * 60 * 1000

interface Entry {
  dirs: string[]
  /** When its folders were first all seen gone (cleared when one is back). */
  missingSince?: number
}

export class ProjectIndex {
  readonly #file: string

  constructor(dataDir: string) {
    this.#file = join(dataDir, "projects.json")
  }

  /** A project opened from a folder: known there (and not missing). */
  seen(projectId: string, dir: string): void {
    const all = this.#read()
    const entry = all[projectId] ?? { dirs: [] }
    all[projectId] = { dirs: [...new Set([...entry.dirs, dir])] }
    this.#write(all)
  }

  /**
   * At the app's start: the projects gone long enough have their takes removed (the ids). A folder
   * whose parent is missing (a drive not there) counts as maybe there: never removed for it.
   */
  sweepRemoved(takes: TakeStore, now = Date.now()): string[] {
    const all = this.#read()
    const removed: string[] = []
    for (const [id, entry] of Object.entries(all)) {
      const gone = entry.dirs.every(
        (d) => !existsSync(join(d, "project.json")) && existsSync(dirname(d)),
      )
      if (!gone) {
        all[id] = { dirs: entry.dirs }
        continue
      }
      const since = entry.missingSince ?? now
      if (now - since < REMOVED_AFTER_MS) {
        all[id] = { ...entry, missingSince: since }
        continue
      }
      takes.removeProject(id)
      delete all[id]
      removed.push(id)
    }
    this.#write(all)
    return removed
  }

  #read(): Record<string, Entry> {
    try {
      const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as unknown
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, Entry>) : {}
    } catch {
      return {}
    }
  }

  #write(all: Record<string, Entry>): void {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 })
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.#file)
  }
}

/** A project's takes pinned as its compositions name them (each scene's, as it is on disk now). */
export function syncPins(opened: OpenedProject, takes: TakeStore): void {
  for (const [sceneId, stored] of opened.scenes) {
    takes.holdOnly(opened.project.id, sceneId, stored.composition?.take?.key)
  }
}
