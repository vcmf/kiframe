import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { ProjectId, SceneId, TakeMeta } from "@kiframe/schema"

// The take store (docs/OBJECT-MODEL.md §0.7): takes live in the app's data directory, never in the
// project folder (they're heavy, and raw frames aren't blurred). Folders are the user's only
// (0700). Encryption at rest and pinning come with M1-8.
//   <root>/takes/<projectId>/<sceneId>/<takeKey>/  frames.webm events.jsonl cursor.jsonl meta.json
// A recording is made in a hidden folder named after its process (`.recording-<pid>-<id>`, the
// recorder's own staging folder inside starts the same way): a leftover is swept only when its
// process is gone, never while it's recording.

export interface StoredTake {
  dir: string
  meta: TakeMeta
}

/** A take key as a folder name (the recorder's: `<prefix>-<recording time>`). */
const TAKE_KEY = /^[A-Za-z0-9_-]{1,128}$/
/** A recording's folder (or the recorder's staging folder inside it), and whose it is. */
const RECORDING = /^\.+recording-(\d+)-([0-9a-f]{12})/

/** One scene's recording in a batch: what the recorder returned for it. */
export type RecordedScene<T> = { ok: true; take: T } | { ok: false; error: unknown }

export class TakeStore {
  readonly root: string
  /** This process's recordings under way (their ids): never swept. */
  readonly #active = new Set<string>()

  constructor(root: string) {
    this.root = root
  }

  #sceneDir(projectId: string, sceneId: string): string {
    return join(this.root, "takes", ProjectId.parse(projectId), SceneId.parse(sceneId))
  }

  /**
   * Records a take of the scene: `run` records into the folder it's given (the runtime's
   * `recordScenario` outDir) and returns what it recorded (its take, with its warnings). A complete
   * take is filed under its key (`recorded.dir` is where it is now); a failed or interrupted one is
   * deleted with its raw frames, and `run`'s error is thrown.
   */
  async record<T extends { meta: TakeMeta }>(
    projectId: string,
    sceneId: string,
    run: (outDir: string) => Promise<T>,
  ): Promise<StoredTake & { recorded: T }> {
    const [result] = await this.recordMany(projectId, [sceneId], async ([outDir]) => {
      try {
        return [{ ok: true, take: await run(outDir ?? "") }]
      } catch (error) {
        return [{ ok: false, error }]
      }
    })
    if (result === undefined || !result.ok) throw result?.error
    return result.take
  }

  /**
   * Records several scenes in one go (the runtime's `recordBatch`: session presets once for all):
   * `run` gets one folder per scene, in order, and returns one result per scene. Each complete
   * take is filed under its key; each failed one is deleted with its raw frames.
   */
  async recordMany<T extends { meta: TakeMeta }>(
    projectId: string,
    sceneIds: readonly string[],
    run: (outDirs: string[]) => Promise<RecordedScene<T>[]>,
  ): Promise<RecordedScene<StoredTake & { recorded: T }>[]> {
    const folders = sceneIds.map((sceneId) => {
      const scene = this.#sceneDir(projectId, sceneId)
      mkdirPrivate(scene)
      sweep(scene, this.#active)
      const id = randomBytes(6).toString("hex")
      this.#active.add(id)
      return { scene, id, outDir: join(scene, `.recording-${process.pid}-${id}`) }
    })
    try {
      let results: RecordedScene<T>[]
      try {
        results = await run(folders.map((f) => f.outDir))
      } catch (error) {
        results = folders.map(() => ({ ok: false, error }))
      }
      return folders.map((f, i) => {
        const result = results[i] ?? { ok: false, error: new Error("no result for this scene") }
        try {
          if (!result.ok) throw result.error
          return { ok: true, take: this.#file(f.scene, f.outDir, result.take) }
        } catch (error) {
          discard(f.outDir)
          return { ok: false, error }
        }
      })
    } finally {
      for (const f of folders) this.#active.delete(f.id)
    }
  }

  #file<T extends { meta: TakeMeta }>(
    scene: string,
    outDir: string,
    recorded: T,
  ): StoredTake & { recorded: T } {
    const meta = TakeMeta.parse(recorded.meta)
    if (meta.outcome.status !== "complete" || !TAKE_KEY.test(meta.takeKey)) {
      throw new Error("the recording didn't produce a complete take")
    }
    const dir = join(scene, meta.takeKey)
    // Keys carry the recording time: a clash is a bug, never a take to overwrite.
    if (existsSync(dir)) throw new Error(`a take "${meta.takeKey}" already exists`)
    chmodSync(outDir, 0o700)
    renameSync(outDir, dir)
    return { dir, meta, recorded: { ...recorded, dir } }
  }

  /** The scene's complete takes, newest first. */
  takes(projectId: string, sceneId: string): StoredTake[] {
    const scene = this.#sceneDir(projectId, sceneId)
    if (!existsSync(scene)) return []
    const out: StoredTake[] = []
    for (const entry of readdirSync(scene, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const take = readTake(join(scene, entry.name))
      if (take !== undefined) out.push(take)
    }
    const time = (t: StoredTake) => Date.parse(t.meta.recordedAt)
    return out.sort((a, b) => time(b) - time(a))
  }

  /**
   * The scene's current take: its newest complete one whose key starts with `keyPrefix` (the
   * runtime's `takeKeyPrefix` of the scene's scenario and project now: after any change, the scene
   * is stale). Only the folders it needs are read (a key ends with its recording time).
   */
  latest(projectId: string, sceneId: string, keyPrefix: string): StoredTake | undefined {
    const scene = this.#sceneDir(projectId, sceneId)
    if (!existsSync(scene)) return undefined
    const time = (name: string) => Number(name.slice(keyPrefix.length))
    const names = readdirSync(scene)
      .filter((n) => n.startsWith(keyPrefix) && TAKE_KEY.test(n) && Number.isFinite(time(n)))
      .sort((a, b) => time(b) - time(a))
    for (const name of names) {
      const take = readTake(join(scene, name))
      if (take !== undefined) return take
    }
    return undefined
  }

  /** The take a composition names (`composition.take.key`), if it's still there. */
  take(projectId: string, sceneId: string, takeKey: string): StoredTake | undefined {
    if (!TAKE_KEY.test(takeKey)) return undefined
    return readTake(join(this.#sceneDir(projectId, sceneId), takeKey))
  }

  /**
   * Deletes every take of a scene, when the scene is deleted (a scene only missing from the project
   * for now, another git branch, keeps its takes: a leftover take matches no other scene's key).
   */
  removeScene(projectId: string, sceneId: string): void {
    rmSync(this.#sceneDir(projectId, sceneId), { recursive: true, force: true })
  }

  /** Removes what recordings cut short by a crash left in a project's scenes (not ones under way). */
  sweepLeftovers(projectId: string): void {
    const project = join(this.root, "takes", ProjectId.parse(projectId))
    if (!existsSync(project)) return
    for (const entry of readdirSync(project, { withFileTypes: true })) {
      if (entry.isDirectory()) sweep(join(project, entry.name), this.#active)
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

/** A recording's folder, and the ones the recorder makes next to it (staging, `.failed`). */
function discard(outDir: string): void {
  rmSync(outDir, { recursive: true, force: true })
  rmSync(`${outDir}.failed`, { recursive: true, force: true })
}

/**
 * Removes the leftovers of recordings whose process is gone (or this process's finished ones),
 * never one under way. Anything else hidden is left alone.
 */
function sweep(scene: string, active: ReadonlySet<string>): void {
  for (const name of readdirSync(scene)) {
    const match = RECORDING.exec(name)
    if (match === null) continue
    const [, pid, id] = match
    const mine = Number(pid) === process.pid
    if (mine ? active.has(id ?? "") : alive(Number(pid))) continue
    rmSync(join(scene, name), { recursive: true, force: true })
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it's another user's
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}
