import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { basename, dirname, join, relative, sep } from "node:path"
import { isRecorderLeftover } from "@kiframe/runtime"
import { CursorSample, ProjectId, SceneId, TakeEvent, TakeMeta } from "@kiframe/schema"

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

/** A take folder's name (and, unanchored, the take a leftover's name was made for). */
const TAKE_NAME = "take-\\d{13}-[0-9a-f]{12}"
const TAKE_DIR = new RegExp(`^${TAKE_NAME}$`)
const LEFTOVER_OF = new RegExp(`^\\.?(${TAKE_NAME})`)
/** The newest take format this Kiframe reads (a newer one is refused, never skipped as not a take). */
const TAKE_VERSION = 1

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
    // Real paths on both sides (the recorder follows links: a store behind one, macOS's /var).
    const real = (p: string) =>
      existsSync(p) ? realpathSync(p) : join(realpathSync(dirname(p)), basename(p))
    const rel = relative(real(join(this.root, "takes")), real(dir)).split(sep)
    const [, , name] = rel
    if (rel.length !== 3 || rel[0] === ".." || name === undefined || !TAKE_DIR.test(name)) {
      throw new Error("not a take folder of this store")
    }
    dropFrames(`${dir}.failed`)
    const take = readTake(dir)
    if (take instanceof Error) throw take
    return take
  }

  /** The scene's complete takes, newest first (by when they were recorded; unreadable ones skipped). */
  takes(projectId: string, sceneId: string): StoredTake[] {
    return this.#takes(projectId, sceneId, false)
  }

  /**
   * The scene's newest complete take. A take folder that can't be read (a permission, an I/O
   * error) is thrown: it may be the newest, never an older one shown instead. Which take is a
   * scene's current one is M1-8's staleness rule; a caller showing it checks `meta.scenarioHash`
   * against the scenario it shows it for.
   */
  latest(projectId: string, sceneId: string): StoredTake | undefined {
    return this.#takes(projectId, sceneId, true)[0]
  }

  /** The take a composition names (`composition.take.key`), if it's still there. */
  take(projectId: string, sceneId: string, takeKey: string): StoredTake | undefined {
    return this.takes(projectId, sceneId).find((t) => t.meta.takeKey === takeKey)
  }

  /** The scene's complete takes, newest first; one that can't be read is skipped or thrown. */
  #takes(projectId: string, sceneId: string, strict: boolean): StoredTake[] {
    const scene = this.#sceneDir(projectId, sceneId)
    if (!existsSync(scene)) return []
    const out: StoredTake[] = []
    for (const name of readdirSync(scene)) {
      if (!TAKE_DIR.test(name)) continue
      const read = readTake(join(scene, name))
      if (read instanceof Error) {
        if (strict) throw read
        continue
      }
      if (read !== undefined) out.push(read)
    }
    return out.sort((a, b) => Date.parse(b.meta.recordedAt) - Date.parse(a.meta.recordedAt))
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
        const names = list(at)
        const leftovers = names.filter((n) => {
          const take = LEFTOVER_OF.exec(n)?.[1]
          if (take === undefined || !isRecorderLeftover(n, take)) return false
          // A set-aside take is the only copy of the previous one until its replacement exists.
          return !/\.old-/.test(n) || names.includes(take)
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
    // Its reason, and the recorder's marker (it's still a take to the recorder).
    if (name === "meta.json" || name === "warnings.json" || name === ".kiframe-take") continue
    try {
      rmSync(join(failed, name), { recursive: true, force: true })
    } catch {
      // swept at the next start
    }
  }
}

/**
 * A complete take in `dir`; undefined when it isn't one (no meta.json, not JSON, a failed take, one
 * an older Kiframe wrote); an Error when it can't be read (a permission, an I/O error) or a newer
 * Kiframe wrote it (never skipped as not a take: an older take would be shown instead).
 */
function readTake(dir: string): StoredTake | Error | undefined {
  let text: string
  try {
    text = readFileSync(join(dir, "meta.json"), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return error instanceof Error ? error : new Error(String(error))
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  const version = (raw as { version?: unknown } | null)?.version
  if (typeof version === "number" && version > TAKE_VERSION) {
    return new Error(
      `${dir}: recorded by a newer Kiframe (take version ${version}): update Kiframe`,
    )
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

/** A take's records as the compositor reads them (validated: a take is data from disk). */
export interface TakeRecords {
  meta: TakeMeta
  events: TakeEvent[]
  cursor: CursorSample[]
}

/**
 * Reads a take folder's records (meta.json, events.jsonl, cursor.jsonl). A take from before secret
 * regions had spans fails validation: re-record it.
 */
export function readTakeRecords(dir: string): TakeRecords {
  const lines = (file: string) =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as unknown)
  return {
    meta: TakeMeta.parse(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))),
    events: lines("events.jsonl").map((e) => TakeEvent.parse(e)),
    cursor: lines("cursor.jsonl").map((c) => CursorSample.parse(c)),
  }
}
