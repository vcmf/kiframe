import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { isRecorderLeftover } from "@kiframe/runtime"
import { ProjectId, SceneId, TakeMeta } from "@kiframe/schema"

// The take store (docs/OBJECT-MODEL.md §0.7): takes live in the app's data directory, never in the
// project folder (they're heavy, and raw frames aren't blurred). The whole store is the user's only
// (its root 0700: nothing inside is reachable by others, whatever a folder's own mode). Encryption
// at rest, pinning, retention and staleness come with M1-8.
//   <root>/takes/<projectId>/<sceneId>/take-<time>-<id>/  frames.webm events.jsonl meta.json …
// The store only names the folders: the runtime's recorder writes each take into its folder
// atomically (staged next to it, swapped in when complete; a failed one kept as `<folder>.failed`,
// whose frames the store deletes, keeping its meta.json: the reason it failed). Takes are never
// deleted with a scene (another git branch's composition may name them): retention is M1-8's. One
// Kiframe process per take store (the app holds a single-instance lock): the sweep at start
// removes what a crash left.

export interface StoredTake {
  dir: string
  meta: TakeMeta
}

const TAKE_DIR = /^take-\d{13}-[0-9a-f]{12}$/

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
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
    const scene = this.#sceneDir(projectId, sceneId)
    mkdirSync(scene, { recursive: true, mode: 0o700 })
    return join(scene, `take-${Date.now()}-${randomBytes(6).toString("hex")}`)
  }

  /**
   * After a recording, complete, failed or thrown, with the folder `newTakeDir` gave: the take, if
   * the recorder placed a complete one (it may have and still thrown: a file error after the take
   * was in place, then shown as a warning). A failed take's frames are deleted (best effort: the
   * start's sweep catches a leftover); its meta.json stays, with the reason.
   */
  settle(dir: string): StoredTake | undefined {
    const rel = relative(join(this.root, "takes"), dir).split(sep)
    const [, , name] = rel
    if (rel.length !== 3 || rel[0] === ".." || name === undefined || !TAKE_DIR.test(name)) {
      throw new Error("not a take folder of this store")
    }
    dropFrames(`${dir}.failed`)
    return readTake(dir)
  }

  /** The scene's complete takes, newest first (by when they were recorded). */
  takes(projectId: string, sceneId: string): StoredTake[] {
    return [...this.#complete(projectId, sceneId)].sort(
      (a, b) => Date.parse(b.meta.recordedAt) - Date.parse(a.meta.recordedAt),
    )
  }

  /**
   * The scene's newest complete take. Which take is a scene's current one is M1-8's staleness rule;
   * a caller showing it checks `meta.scenarioHash` against the scenario it shows it for.
   */
  latest(projectId: string, sceneId: string): StoredTake | undefined {
    return this.takes(projectId, sceneId)[0]
  }

  /** The take a composition names (`composition.take.key`), if it's still there. */
  take(projectId: string, sceneId: string, takeKey: string): StoredTake | undefined {
    for (const take of this.#complete(projectId, sceneId)) {
      if (take.meta.takeKey === takeKey) return take
    }
    return undefined
  }

  /** The scene's complete takes, in no order. */
  *#complete(projectId: string, sceneId: string): Generator<StoredTake> {
    const scene = this.#sceneDir(projectId, sceneId)
    if (!existsSync(scene)) return
    for (const name of readdirSync(scene)) {
      if (!TAKE_DIR.test(name)) continue
      const take = readTake(join(scene, name))
      if (take !== undefined) yield take
    }
  }

  /**
   * At the app's start, before any recording: removes what a crash left (the recorder's staging
   * folders, replaced takes set aside) and the frames of failed takes. Nothing else is touched.
   */
  sweep(): void {
    const takes = join(this.root, "takes")
    if (!existsSync(takes)) return
    for (const project of list(takes)) {
      for (const scene of list(join(takes, project))) {
        const at = join(takes, project, scene)
        // What the recorder left next to a take folder of ours (the name it was made for).
        const leftovers = list(at).filter((n) => {
          const take = /^\.?(take-\d{13}-[0-9a-f]{12})/.exec(n)?.[1]
          return take !== undefined && isRecorderLeftover(n, take)
        })
        for (const name of leftovers) {
          if (name.endsWith(".failed")) dropFrames(join(at, name))
          else {
            try {
              rmSync(join(at, name), { recursive: true, force: true })
            } catch {
              // held: swept at the next start
            }
          }
        }
      }
    }
  }
}

/** A failed take's raw material (frames, shots), keeping its meta.json and warnings. */
function dropFrames(failed: string): void {
  if (!existsSync(failed)) return
  for (const name of list(failed)) {
    if (name === "meta.json" || name === "warnings.json") continue
    try {
      rmSync(join(failed, name), { recursive: true, force: true })
    } catch {
      // swept at the next start
    }
  }
}

/**
 * A complete take in `dir`, or undefined when it isn't one (no meta.json, a failed or older
 * Kiframe's take). Any other read error (permissions, I/O) is thrown: never an older take shown
 * instead of the newest by mistake.
 */
function readTake(dir: string): StoredTake | undefined {
  let text: string
  try {
    text = readFileSync(join(dir, "meta.json"), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  const meta = TakeMeta.safeParse(raw)
  return meta.success && meta.data.outcome.status === "complete"
    ? { dir, meta: meta.data }
    : undefined
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
