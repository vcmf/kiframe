import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
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
import { removeStrayTemps } from "./files.ts"
import { encryptPlainFile, isEncryptedFile, readTakeFileAsync } from "./take-crypt.ts"
import { newerTake, readTakeRecordsAsync, type TakeRecords } from "./take-records.ts"

// The take store (docs/OBJECT-MODEL.md §0.7): takes live in the app's data directory, never in the
// project folder (they're heavy, and raw frames aren't blurred). The whole store is the user's only
// (its root 0700: nothing inside is reachable by others, whatever a folder's own mode). With a key
// (M1-8), a take's files are encrypted as it settles, and at start what a crash left plain.
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

/** A take as it settled: its encryption not done now is said (sealed at the next start). */
export interface SettledTake extends StoredTake {
  warning?: string
}

/** A take's records and its frames, decrypted. */
export interface OpenedTake {
  records: TakeRecords
  video: Buffer
}

export interface TakeStoreOptions {
  /** The store's key (32 bytes), asked for once when first needed; none: takes stay plain. */
  key?: () => Promise<Uint8Array>
}

/** Written once every file of a take is encrypted: then a file without the magic was changed. */
const SEALED_MARK = ".sealed"

/** A take's files the store encrypts (meta.json stays plain: listing needs no key). */
const SEALED = ["frames.webm", "events.jsonl", "cursor.jsonl"]

/** A take folder's name (and, unanchored, the take a leftover's name was made for). */
const TAKE_NAME = "take-\\d{13}-[0-9a-f]{12}"
const TAKE_DIR = new RegExp(`^${TAKE_NAME}$`)
const LEFTOVER_OF = new RegExp(`^\\.?(${TAKE_NAME})`)

export class TakeStore {
  readonly root: string
  readonly #options: TakeStoreOptions
  #key: Promise<Uint8Array> | undefined
  /** The store's writes one at a time (a take settling, a take sealed at start: never both). */
  #lock: Promise<unknown> = Promise.resolve()

  constructor(root: string, options: TakeStoreOptions = {}) {
    this.root = root
    this.#options = options
  }

  /** Runs `work` alone among the store's writes (the next waits for it, whatever it gives). */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#lock.then(work)
    this.#lock = run.catch(() => undefined)
    return run
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
  async settle(dir: string): Promise<SettledTake | undefined> {
    let warning: string | undefined
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
    // file that can't be written now (a full disk): the take kept, sealed at the next start.
    if (this.#options.key !== undefined) {
      await this.#exclusive(async () => {
        let key: Uint8Array | undefined
        try {
          key = await this.#theKey()
        } catch (error) {
          rmSync(dir, { recursive: true, force: true })
          throw new Error(
            `the take couldn't be encrypted (the take key: ${message(error)}): deleted, record the scene again`,
            { cause: error },
          )
        }
        // A file that can't be written now: kept, said (sealed at the next start).
        if (key !== undefined) {
          await sealTake(dir, key).catch((error: unknown) => {
            warning = `its take stays unencrypted until Kiframe starts again (${message(error)})`
          })
        }
      })
    }
    return warning === undefined ? take : { ...take, warning }
  }

  /**
   * At the app's start, after `sweep`: every placed take's plain files encrypted (a crash between
   * the recorder placing a take and its encryption, a take from before; an encrypted file is known
   * from its first bytes), and a crash's half-written files removed. One take that fails is said
   * and the others go on.
   */
  async seal(): Promise<{ sealed: number; failed: string[] }> {
    let count = 0
    const failed: string[] = []
    // The key asked once at most: refused, said once, and sealing stops (never a prompt per take).
    let refused = false
    const key = async () => {
      try {
        return await this.#theKey()
      } catch (error) {
        refused = true
        throw new Error(`the take key: ${message(error)}`, { cause: error })
      }
    }
    const takes = join(this.root, "takes")
    for (const project of list(takes)) {
      for (const scene of list(join(takes, project))) {
        for (const name of list(join(takes, project, scene))) {
          if (!TAKE_DIR.test(name)) continue
          const dir = join(takes, project, scene, name)
          // A sealed take is done (later starts cost a folder listing). One take at a time under
          // the lock (a recording settling meanwhile waits for one take, never the whole store).
          if (refused) break
          if (existsSync(join(dir, SEALED_MARK))) continue
          await this.#exclusive(async () => {
            try {
              removeStrayTemps(dir, true)
              if (this.#options.key === undefined) return
              // The key asked only for a take that needs it (an empty store never asks).
              if (await sealTake(dir, key)) count += 1
            } catch (error) {
              failed.push(refused ? message(error) : `${dir}: ${message(error)}`)
            }
          })
        }
      }
    }
    return { sealed: count, failed }
  }

  /**
   * A take's records and frames, decrypted: each file read once, the key asked only when what was
   * read is encrypted (a take sealed meanwhile reads either way: never judged, then read changed).
   */
  async open(take: StoredTake): Promise<OpenedTake> {
    const sealedTake = existsSync(join(take.dir, SEALED_MARK))
    const key = () => this.#theKey()
    const records = await readTakeRecordsAsync(take.dir, key, sealedTake)
    const video = await readTakeFileAsync(join(take.dir, "frames.webm"), key, sealedTake)
    return { records, video }
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Encrypts a take's plain files (each written whole and synced), then marks it sealed (a mark lost
 * to a crash: the next start checks the files again). `key` asked only when a file is plain.
 * Whether it encrypted any.
 */
async function sealTake(
  dir: string,
  key: Uint8Array | (() => Promise<Uint8Array | undefined>),
): Promise<boolean> {
  let changed = false
  let theKey = typeof key === "function" ? undefined : key
  for (const file of sealed(dir)) {
    if (await isEncryptedFile(file)) continue
    theKey ??= typeof key === "function" ? await key() : key
    if (theKey === undefined) return changed
    await encryptPlainFile(file, theKey)
    changed = true
  }
  writeFileSync(join(dir, SEALED_MARK), "", { mode: 0o600 })
  return changed
}
