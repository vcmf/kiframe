// The take store's bookkeeping in the app (OBJECT-MODEL §0.7): scratch takes evicted beyond the
// budget. A take is named (kept) when a composition of a project's folder names it, read from the
// folders themselves each time (pins derived, never stored). A project whose folders are all gone
// (deleted, or moved and not opened since) names nothing: its takes go first, only for space, never
// for being gone (decided by the user). A project whose folders can't all be read keeps every take.
// Runs at start and after a recording, one pass at a time (a recording meanwhile asks for one
// more). Electron-free.
import type { NamedTakes, TakeStore } from "@kiframe/project"
import type { Inspect } from "./folder-reader.ts"
import type { Folder } from "./folder-inspect.ts"
import type { ProjectIndex } from "./project-index.ts"

export class TakeKeeper {
  readonly #takes: TakeStore
  readonly #index: ProjectIndex
  readonly #inspect: Inspect
  readonly #open: () => string | undefined
  readonly #now: () => number
  #running: Promise<void> | undefined
  #again = false

  /** `open`: the project open in the app now (never vanished while open, its index write failed). */
  constructor(
    takes: TakeStore,
    index: ProjectIndex,
    inspect: Inspect,
    open: () => string | undefined = () => undefined,
    now = () => Date.now(),
  ) {
    this.#takes = takes
    this.#index = index
    this.#inspect = inspect
    this.#open = open
    this.#now = now
  }

  /**
   * Evicts (a pass under way: one more after it, never two at once). A pass that fails doesn't
   * drop one asked meanwhile; the call fails only when the last pass did.
   */
  evict(): Promise<void> {
    if (this.#running !== undefined) {
      this.#again = true
      return this.#running
    }
    this.#running = (async () => {
      try {
        let failed: { error: unknown } | undefined
        do {
          this.#again = false
          try {
            await this.#pass()
            failed = undefined
          } catch (error) {
            failed = { error }
          }
        } while (this.#again)
        if (failed !== undefined) throw failed.error
      } finally {
        this.#running = undefined
      }
    })()
    return this.#running
  }

  async #pass(): Promise<void> {
    // The index read once for the pass. Under the store's lock (where an opening can't slip in),
    // a project is asked again: one opened from a new place meanwhile loses nothing, nor one
    // decided with a folder gone that's open now (its index write failed).
    const index = this.#index.all()
    const decided = new Map<string, { folders: string; withGone: boolean }>()
    await this.#takes.evict(
      async (projectId) => {
        const folders = index[projectId] ?? []
        const { named, withGone } = await this.#namedBy(projectId, folders)
        decided.set(projectId, { folders: fingerprint(folders), withGone })
        return named
      },
      this.#now(),
      (projectId) => {
        const was = decided.get(projectId)
        if (was === undefined || (was.withGone && projectId === this.#open())) return false
        return was.folders === fingerprint(this.#index.folders(projectId))
      },
    )
  }

  /**
   * What a project's folders name now: every folder there and read, their names merged; some gone
   * and the rest there, the ones there (a gone copy names nothing); all gone, vanished. Else (a
   * folder unknown, the project not known, or open now with a folder gone) keep.
   */
  async #namedBy(
    projectId: string,
    folders: Folder[],
  ): Promise<{ named: NamedTakes; withGone: boolean }> {
    if (folders.length === 0) return { named: "keep", withGone: false }
    const scenes = new Map<string, Set<string>>()
    const unread = new Set<string>()
    let here = 0
    for (const folder of folders) {
      const state = await this.#inspect(folder, projectId)
      if (state.state === "unknown") return { named: "keep", withGone: false }
      if (state.state === "gone") continue
      here += 1
      for (const [scene, key] of Object.entries(state.scenes)) {
        scenes.set(scene, (scenes.get(scene) ?? new Set()).add(key))
      }
      for (const scene of state.unread) unread.add(scene)
    }
    const withGone = here < folders.length
    if (withGone && projectId === this.#open()) return { named: "keep", withGone }
    return { named: here === 0 ? "vanished" : { scenes, unread }, withGone }
  }
}

/** A project's folders as known (a change: opened from another place, or the index unread). */
function fingerprint(folders: Folder[]): string {
  // In any order (opened again from one of them moves it last: not a change).
  return JSON.stringify(folders.map((f) => [f.path, f.dev ?? null]).sort())
}
