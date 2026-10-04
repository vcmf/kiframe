import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, relative, sep } from "node:path"
import { isRecorderLeftover } from "@kiframe/runtime"
import { ProjectId, SceneId, TakeMeta } from "@kiframe/schema"
import type { OpenedProject } from "./project.ts"
import { jsonText, removeStrayTemps, writeAtomic } from "./files.ts"
import { encryptFile, isEncryptedFile, readTakeFileAsync } from "./take-crypt.ts"
import { newerTake, readTakeRecords, type TakeRecords } from "./take-records.ts"

// The take store (docs/OBJECT-MODEL.md §0.7): takes live in the app's data directory, never in the
// project folder (they're heavy, and raw frames aren't blurred). The whole store is the user's only
// (its root 0700: nothing inside is reachable by others, whatever a folder's own mode). With a key
// (M1-8), a take's files are encrypted as it settles; pinned takes (a composition names them) are
// kept, scratch ones evicted beyond a budget, least recently used first.
//   <root>/takes/<projectId>/<sceneId>/take-<time>-<id>/  frames.webm events.jsonl meta.json …
//     pin.json (what holds it), used (when it was last played)
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

/** A take's records and its frames, decrypted. */
export interface OpenedTake {
  records: TakeRecords
  video: Buffer
}

/**
 * What holds a take (a pin): a scene's composition in one copy of a project (its folder: two
 * copies of a project, a worktree, hold their own takes); later an export, a named version.
 */
export interface Holder {
  project: string
  dir: string
  scene: string
  by: "composition"
}

export interface TakeStoreOptions {
  /** The store's key (32 bytes), asked for once when first needed; none: takes stay plain. */
  key?: () => Promise<Uint8Array>
  /** Bytes scratch takes may use before the least recently used go (default 5 GB). */
  scratchBudget?: number
}

/** Scratch takes' default budget (decided by the user, 2026-10-04). */
export const SCRATCH_BUDGET = 5 * 1024 ** 3

/** A take's files the store encrypts (meta.json and pin.json stay plain: listing needs no key). */
const SEALED = ["frames.webm", "events.jsonl", "cursor.jsonl"]

/** A take folder's name (and, unanchored, the take a leftover's name was made for). */
const TAKE_NAME = "take-\\d{13}-[0-9a-f]{12}"
const TAKE_DIR = new RegExp(`^${TAKE_NAME}$`)
const LEFTOVER_OF = new RegExp(`^\\.?(${TAKE_NAME})`)

export class TakeStore {
  readonly root: string
  readonly #options: TakeStoreOptions
  #key: Promise<Uint8Array> | undefined
  /** Projects whose pins were synced in this process: only their scratch takes are evicted. */
  readonly #synced = new Set<string>()
  /** Take folders' sizes, once measured (a take never grows: its pin and used files are bytes). */
  readonly #sizes = new Map<string, number>()

  constructor(root: string, options: TakeStoreOptions = {}) {
    this.root = root
    this.#options = options
  }

  /** The key, asked for once (a failed ask is asked again next time); none: plain takes. */
  async #theKey(): Promise<Uint8Array | undefined> {
    const ask = this.#options.key
    if (ask === undefined) return undefined
    this.#key ??= ask().catch((error: unknown) => {
      this.#key = undefined
      throw error
    })
    return this.#key
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
  async settle(dir: string): Promise<StoredTake | undefined> {
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
    if (take === undefined) return undefined
    // Encrypted before it counts. No key (the keychain refused): never kept plain, deleted. A
    // crash partway: the start's `seal` encrypts what's left plain.
    if (this.#options.key !== undefined) {
      try {
        const key = await this.#theKey()
        if (key !== undefined) for (const file of sealed(dir)) await encryptFile(file, key)
      } catch (error) {
        rmSync(dir, { recursive: true, force: true })
        throw new Error(
          `the take couldn't be encrypted (${error instanceof Error ? error.message : String(error)}): deleted, record the scene again`,
          { cause: error },
        )
      }
    }
    markUsed(dir)
    return take
  }

  /**
   * At the app's start, after `sweep`: every placed take's plain files encrypted (a crash between
   * the recorder placing a take and its encryption, a take from before; an encrypted file is known
   * from its first bytes), and a crash's half-written files removed. One take that fails is said
   * and the others go on.
   */
  async seal(): Promise<{ sealed: number; failed: string[] }> {
    const key = this.#options.key === undefined ? undefined : await this.#theKey()
    let count = 0
    const failed: string[] = []
    const takes = join(this.root, "takes")
    for (const project of list(takes)) {
      for (const scene of list(join(takes, project))) {
        for (const name of list(join(takes, project, scene))) {
          if (!TAKE_DIR.test(name)) continue
          const dir = join(takes, project, scene, name)
          try {
            removeStrayTemps(dir, true)
            if (key === undefined) continue
            let changed = false
            for (const file of sealed(dir)) {
              const before = await isEncryptedFile(file)
              await encryptFile(file, key)
              changed ||= !before
            }
            if (changed) count += 1
          } catch (error) {
            failed.push(`${dir}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
    }
    return { sealed: count, failed }
  }

  /** A take's records and frames, decrypted (a key needed for an encrypted one). Marks it used. */
  async open(take: StoredTake): Promise<OpenedTake> {
    const key = await this.#theKey()
    const records = readTakeRecords(take.dir, key)
    // The frames read without holding the thread (tens of MB).
    const video = await readTakeFileAsync(join(take.dir, "frames.webm"), key)
    markUsed(take.dir)
    return { records, video }
  }

  /**
   * One copy of a project (its folder) holds the takes its compositions name now, and no others
   * (a scene recorded again, given new steps, or removed lets its old take go). Its scratch takes
   * may then be evicted (a project never synced in this process keeps every take).
   */
  syncProject(
    projectId: string,
    dir: string,
    named: Map<string, string | undefined>,
    /** Scenes that didn't read (a merge conflict, a hand edit): their pins left as they are. */
    unread: ReadonlySet<string> = new Set(),
  ): void {
    const copy = realDir(dir)
    const of = join(this.root, "takes", ProjectId.parse(projectId))
    for (const scene of list(of)) {
      if (unread.has(scene)) continue
      for (const name of list(join(of, scene))) {
        if (!TAKE_DIR.test(name)) continue
        const take = readTake(join(of, scene, name))
        if (take === undefined || take instanceof Error) continue
        // Pins that don't read are left as they are (held: never evicted, never rewritten).
        const pins = pinsOf(take.dir)
        if (pins === undefined) continue
        const holders = pins.filter((h) => !(h.project === projectId && h.dir === copy))
        if (named.get(scene) === take.meta.takeKey) {
          holders.push({ project: projectId, dir: copy, scene, by: "composition" })
        }
        writePins(take.dir, holders)
      }
    }
    this.#synced.add(projectId)
  }

  /** A copy of a project gone for good (its folder, the project elsewhere): its pins go. */
  forgetCopy(projectId: string, dir: string): void {
    const copy = realDir(dir)
    const of = join(this.root, "takes", ProjectId.parse(projectId))
    for (const scene of list(of)) {
      for (const name of list(join(of, scene))) {
        if (!TAKE_DIR.test(name)) continue
        const pins = pinsOf(join(of, scene, name))
        if (pins === undefined) continue
        const kept = pins.filter((h) => !(h.project === projectId && h.dir === copy))
        if (kept.length !== pins.length) writePins(join(of, scene, name), kept)
      }
    }
  }

  /**
   * Deletes scratch takes (held by nothing) beyond the budget, least recently used first; pinned
   * takes never. The folders deleted.
   */
  evict(): string[] {
    const budget = this.#options.scratchBudget ?? SCRATCH_BUDGET
    const scratch: { dir: string; used: number; size: number }[] = []
    const takes = join(this.root, "takes")
    // Only projects whose pins are known now (an older take may have no pin.json yet).
    for (const project of list(takes).filter((p) => this.#synced.has(p))) {
      for (const scene of list(join(takes, project))) {
        for (const name of list(join(takes, project, scene))) {
          if (!TAKE_DIR.test(name)) continue
          const dir = join(takes, project, scene, name)
          if ((pinsOf(dir) ?? ["unreadable: held"]).length > 0) continue
          let size = this.#sizes.get(dir)
          if (size === undefined) {
            size = sizeOf(dir)
            this.#sizes.set(dir, size)
          }
          scratch.push({ dir, used: usedAt(dir), size })
        }
      }
    }
    let total = scratch.reduce((sum, t) => sum + t.size, 0)
    const gone: string[] = []
    for (const take of scratch.sort((a, b) => a.used - b.used)) {
      if (total <= budget) break
      try {
        rmSync(take.dir, { recursive: true, force: true })
        this.#sizes.delete(take.dir)
        total -= take.size
        gone.push(take.dir)
      } catch {
        // held: evicted next time
      }
    }
    return gone
  }

  /** Deletes every take of a project (removed: decided by the host), pinned ones too. */
  removeProject(projectId: string): void {
    rmSync(join(this.root, "takes", ProjectId.parse(projectId)), { recursive: true, force: true })
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

  /**
   * The take a composition names (`composition.take.key`), if it's still there. A take folder that
   * can't be read is thrown (it may be that one: never said to be gone).
   */
  take(projectId: string, sceneId: string, takeKey: string): StoredTake | undefined {
    return this.#takes(projectId, sceneId, true).find((t) => t.meta.takeKey === takeKey)
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

/** A take's files the store seals: its frames, events, cursor, and shots (those that are there). */
function sealed(dir: string): string[] {
  const files = SEALED.map((f) => join(dir, f)).filter((f) => existsSync(f))
  const shots = join(dir, "shots")
  return [...files, ...list(shots).map((f) => join(shots, f))]
}

/**
 * What holds a take (none: scratch); undefined when its pin.json doesn't read (held by doubt:
 * never evicted, never rewritten). A holder that isn't one (a future format) is kept as it is.
 */
function pinsOf(dir: string): Holder[] | undefined {
  const file = join(dir, "pin.json")
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { holders?: unknown }
    if (!Array.isArray(parsed.holders)) return undefined
    return (parsed.holders as unknown[]).map((h) =>
      typeof h === "object" && h !== null ? (h as Holder) : ({ held: h } as unknown as Holder),
    )
  } catch {
    return undefined
  }
}

function writePins(dir: string, holders: Holder[]): void {
  const file = join(dir, "pin.json")
  if (holders.length === 0) {
    rmSync(file, { force: true })
    return
  }
  writeAtomic(file, jsonText({ holders }), 0o600)
}

/** A folder as one path (links resolved: two spellings of a folder are one copy). */
function realDir(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/** When a take was last played (or recorded): its `used` file, else its folder's time. */
function usedAt(dir: string): number {
  try {
    const at = Number(readFileSync(join(dir, "used"), "utf8"))
    if (Number.isFinite(at) && at > 0) return at
  } catch {
    // none yet
  }
  try {
    return lstatSync(dir).mtimeMs
  } catch {
    return 0
  }
}

function markUsed(dir: string): void {
  try {
    writeFileSync(join(dir, "used"), String(Date.now()), { mode: 0o600 })
  } catch {
    // best effort: an older time only makes it go sooner
  }
}

/** A folder's size in bytes (its files, links not followed). */
function sizeOf(dir: string): number {
  let size = 0
  for (const name of list(dir)) {
    const path = join(dir, name)
    try {
      const st = lstatSync(path)
      size += st.isDirectory() ? sizeOf(path) : st.size
    } catch {
      // gone meanwhile
    }
  }
  return size
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
  const newer = newerTake(raw, dir)
  if (newer !== undefined) return newer
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

/** A project's pins synced with its compositions as they are (on open, after a save or a recording). */
export function syncPins(opened: OpenedProject, takes: TakeStore): void {
  const named = new Map([...opened.scenes].map(([id, s]) => [id, s.composition?.take?.key]))
  // A scene a part of which didn't read, or whose folder is missing: its pins as they are.
  const unread = new Set(opened.problems.map((p) => p.sceneId).filter((id) => id !== undefined))
  takes.syncProject(opened.project.id, opened.dir, named, unread)
}
