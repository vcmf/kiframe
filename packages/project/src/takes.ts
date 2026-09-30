import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ProjectId, SceneId, TakeMeta } from "@kiframe/schema"

// The take store (docs/OBJECT-MODEL.md §0.7): takes live in the app's data directory, never in the
// project folder (they're heavy, and raw frames aren't blurred). Folders are the user's only
// (0700). Encryption at rest, pinning, retention and staleness come with M1-8.
//   <root>/takes/<projectId>/<sceneId>/take-<time>-<id>/  frames.webm events.jsonl meta.json …
// The store only names the folders: the runtime's recorder writes each take into its folder
// atomically (staged next to it, swapped in when complete; a failed one kept as `<folder>.failed`,
// which the store deletes: raw frames of a failure aren't kept). One Kiframe process per take store
// (the app holds a single-instance lock): the sweep at start removes what a crash left.

export interface StoredTake {
  dir: string
  meta: TakeMeta
}

const TAKE_DIR = /^take-(\d{13})-[0-9a-f]{12}$/

export class TakeStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  #sceneDir(projectId: string, sceneId: string): string {
    return join(this.root, "takes", ProjectId.parse(projectId), SceneId.parse(sceneId))
  }

  /**
   * A new take's folder for the scene, to record into (the recorder's `outDir`; for a batch, one
   * per scene). Nothing is created in it: the recorder writes the take whole or not at all.
   */
  newTakeDir(projectId: string, sceneId: string): string {
    const scene = this.#sceneDir(projectId, sceneId)
    mkdirSync(scene, { recursive: true, mode: 0o700 })
    chmodSync(scene, 0o700)
    return join(scene, `take-${Date.now()}-${randomBytes(6).toString("hex")}`)
  }

  /**
   * After a recording (complete, failed, or thrown): the take in `dir`, if it's complete. A failed
   * one's frames are deleted (best effort: the start's sweep catches a leftover).
   */
  settle(dir: string): StoredTake | undefined {
    try {
      rmSync(`${dir}.failed`, { recursive: true, force: true })
    } catch {
      // swept at the next start
    }
    const take = readTake(dir)
    if (take !== undefined) chmodSync(dir, 0o700)
    return take
  }

  /** The scene's complete takes, newest first. */
  takes(projectId: string, sceneId: string): StoredTake[] {
    const out: StoredTake[] = []
    for (const name of this.#names(projectId, sceneId)) {
      const take = readTake(join(this.#sceneDir(projectId, sceneId), name))
      if (take !== undefined) out.push(take)
    }
    return out
  }

  /**
   * The scene's newest complete take (its folder name starts with its time: only the folders up to
   * the first complete one are read). Which take is a scene's current one is M1-8's staleness rule;
   * a caller showing it checks `meta.scenarioHash` against the scenario it shows it for.
   */
  latest(projectId: string, sceneId: string): StoredTake | undefined {
    for (const name of this.#names(projectId, sceneId)) {
      const take = readTake(join(this.#sceneDir(projectId, sceneId), name))
      if (take !== undefined) return take
    }
    return undefined
  }

  /** The take a composition names (`composition.take.key`), if it's still there. */
  take(projectId: string, sceneId: string, takeKey: string): StoredTake | undefined {
    return this.takes(projectId, sceneId).find((t) => t.meta.takeKey === takeKey)
  }

  /** Take folder names, newest first. */
  #names(projectId: string, sceneId: string): string[] {
    const scene = this.#sceneDir(projectId, sceneId)
    if (!existsSync(scene)) return []
    const time = (name: string) => Number(TAKE_DIR.exec(name)?.[1] ?? 0)
    return readdirSync(scene)
      .filter((name) => TAKE_DIR.test(name))
      .sort((a, b) => time(b) - time(a))
  }

  /**
   * Deletes every take of a scene, when the scene is deleted (never because a scene is missing from
   * the project for now: another git branch keeps its takes).
   */
  removeScene(projectId: string, sceneId: string): void {
    rmSync(this.#sceneDir(projectId, sceneId), { recursive: true, force: true })
  }

  /**
   * At the app's start, before any recording: removes what a crash left in the store (failed takes,
   * the recorder's staging folders). Anything that isn't a take folder is left alone.
   */
  sweep(): void {
    const takes = join(this.root, "takes")
    if (!existsSync(takes)) return
    for (const project of readdirSync(takes)) {
      for (const scene of safeList(join(takes, project))) {
        for (const name of safeList(join(takes, project, scene))) {
          const leftover =
            /^take-\d{13}-[0-9a-f]{12}\.failed$/.test(name) ||
            /^\.take-\d{13}-[0-9a-f]{12}\.recording-/.test(name)
          if (!leftover) continue
          try {
            rmSync(join(takes, project, scene, name), { recursive: true, force: true })
          } catch {
            // held: swept at the next start
          }
        }
      }
    }
  }
}

function readTake(dir: string): StoredTake | undefined {
  try {
    const meta = TakeMeta.parse(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")))
    return meta.outcome.status === "complete" ? { dir, meta } : undefined
  } catch {
    // not a take (or one written by an older Kiframe): not listed
    return undefined
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
