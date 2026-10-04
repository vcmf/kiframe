// The take store's bookkeeping in the app (OBJECT-MODEL §0.7): removed projects' takes deleted
// (every folder gone 7 days, decided by the user), and scratch takes evicted beyond the budget. A
// take is named (kept) when a composition of a project's folder names it, read from the folders
// themselves each time (pins derived, never stored); a project whose folders can't all be read
// now keeps every take. Runs at start and after a recording, one pass at a time (a recording
// meanwhile asks for one more). Electron-free.
import type { NamedTakes, TakeStore } from "@kiframe/project"
import type { Inspect } from "./folder-reader.ts"
import type { FolderState } from "./folder-inspect.ts"
import type { ProjectIndex } from "./project-index.ts"

/** How long a folder stays gone before its copy is forgotten, or (all gone) the project's takes go. */
export const REMOVED_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export class TakeKeeper {
  readonly #takes: TakeStore
  readonly #index: ProjectIndex
  readonly #inspect: Inspect
  readonly #now: () => number
  #running: Promise<void> | undefined
  #again = false

  constructor(takes: TakeStore, index: ProjectIndex, inspect: Inspect, now = () => Date.now()) {
    this.#takes = takes
    this.#index = index
    this.#inspect = inspect
    this.#now = now
  }

  /** At start: removed projects' takes, then eviction. */
  async tidy(): Promise<void> {
    await this.#removeRemoved()
    await this.evict()
  }

  /** Evicts (a pass under way: one more after it, never two at once). */
  evict(): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = true
      return this.#running
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false
          await this.#takes.evict((projectId) => this.#namedBy(projectId), this.#now())
        } while (this.#again)
      } finally {
        this.#running = undefined
      }
    })()
    return this.#running
  }

  /** What a project's folders name now; "keep" unless every one of them is there and read. */
  async #namedBy(projectId: string): Promise<NamedTakes> {
    const folders = this.#index.folders(projectId)
    if (folders.length === 0) return "keep"
    const scenes = new Map<string, Set<string>>()
    const unread = new Set<string>()
    for (const folder of folders) {
      const state = await this.#inspect(folder, projectId)
      if (state.state !== "here") return "keep"
      for (const [scene, key] of Object.entries(state.scenes)) {
        scenes.set(scene, (scenes.get(scene) ?? new Set()).add(key))
      }
      for (const scene of state.unread) unread.add(scene)
    }
    return { scenes, unread }
  }

  /**
   * Each known folder looked at: gone ones dated (back or unknown: undated); a folder gone 7 days
   * forgotten while its project is elsewhere; a project whose every folder is, its takes deleted,
   * checked again under the store's lock (a copy opened meanwhile keeps them).
   */
  async #removeRemoved(): Promise<void> {
    const now = this.#now()
    // Each folder's state, by its path (a folder added meanwhile is left as it is).
    const states = new Map<string, Map<string, FolderState>>()
    for (const [id, folders] of Object.entries(this.#index.all())) {
      const looked = new Map<string, FolderState>()
      for (const folder of folders) looked.set(folder.path, await this.#inspect(folder, id))
      states.set(id, looked)
    }
    // Dated from what was looked at (a folder opened meanwhile is undated by `seen`, not here).
    this.#index.change((all) => {
      for (const [id, looked] of states) {
        const folders = all[id]
        if (folders === undefined) continue
        all[id] = folders.map((f) => {
          const state = looked.get(f.path)
          if (state === undefined) return f
          if (state.state !== "gone") {
            const { missingSince: _gone, ...rest } = f
            return rest
          }
          return { ...f, missingSince: f.missingSince ?? now }
        })
      }
    })
    const due = (since: number | undefined) =>
      since !== undefined && now - since >= REMOVED_AFTER_MS
    for (const [id, folders] of Object.entries(this.#index.all())) {
      if (!folders.every((f) => due(f.missingSince))) {
        // A copy gone for good, the project elsewhere: forgotten.
        if (folders.some((f) => due(f.missingSince))) {
          this.#index.change((all) => {
            all[id] = (all[id] ?? []).filter((f) => !due(f.missingSince))
          })
        }
        continue
      }
      const removed = await this.#takes.removeProject(id, () =>
        this.#index.folders(id).every((f) => due(f.missingSince)),
      )
      // Forgotten once its takes are gone (a removal that didn't happen is tried next start).
      if (removed) {
        this.#index.change((all) => {
          delete all[id]
        })
      }
    }
  }
}
