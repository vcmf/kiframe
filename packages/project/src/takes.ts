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
// (0700). Encryption at rest, pinning and staleness (which take is a scene's current one) come with
// M1-8.
//   <root>/takes/<projectId>/<sceneId>/<takeKey>/  frames.webm events.jsonl cursor.jsonl meta.json
// One Kiframe process per take store (the app holds a single-instance lock): a recording is made
// in a hidden `.recording-<id>` folder, and a hidden folder that isn't one of this process's
// recordings under way is a crash's leftover, swept.

export interface StoredTake {
  dir: string
  meta: TakeMeta
}

/** One scene's recording in a batch: what the recorder returned for it, or why it failed. */
export type RecordedScene<T> = { ok: true; take: T } | { ok: false; error: unknown }

/** A take key as a folder name (the recorder's: a hash, then the recording time). */
const TAKE_KEY = /^[A-Za-z0-9_-]{1,128}$/
/** This process's recordings under way (their folder names), whichever store made them. */
const active = new Set<string>()

export class TakeStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  #sceneDir(projectId: string, sceneId: string): string {
    return join(this.root, "takes", ProjectId.parse(projectId), SceneId.parse(sceneId))
  }

  /**
   * Records a take of the scene: `run` records into the folder it's given (the runtime's
   * `recordScenario` outDir) and returns what it recorded; it must settle only once the recorder
   * has. A complete take is filed under its key (`recorded.dir` is where it is now); a failed one is
   * deleted with its raw frames, and its error is thrown.
   */
  async record<T extends { meta: TakeMeta }>(
    projectId: string,
    sceneId: string,
    run: (outDir: string) => Promise<T>,
  ): Promise<StoredTake & { recorded: T }> {
    const [result] = await this.recordMany(projectId, [sceneId], async ([outDir]) => {
      if (outDir === undefined) return [{ ok: false, error: new Error("no folder") }]
      try {
        return [{ ok: true, take: await run(outDir) }]
      } catch (error) {
        return [{ ok: false, error }]
      }
    })
    if (result?.ok === true) return result.take
    const error = result?.error
    throw error instanceof Error ? error : new Error(`the recording failed: ${String(error)}`)
  }

  /**
   * Records several scenes in one go (the runtime's `recordBatch`: session presets once for all):
   * `run` gets one folder per scene, in order (undefined for a scene that can't be recorded), and
   * returns one result per scene. Each complete take is filed under its key; each failed one is
   * deleted with its raw frames. A scene that can't be set up fails alone.
   */
  async recordMany<T extends { meta: TakeMeta }>(
    projectId: string,
    sceneIds: readonly string[],
    run: (outDirs: (string | undefined)[]) => Promise<RecordedScene<T>[]>,
  ): Promise<RecordedScene<StoredTake & { recorded: T }>[]> {
    type Folder = { scene: string; name: string; outDir: string } | { error: unknown }
    const folders = sceneIds.map((sceneId): Folder => {
      try {
        const scene = this.#sceneDir(projectId, sceneId)
        mkdirPrivate(scene)
        sweep(scene)
        const name = `.recording-${randomBytes(6).toString("hex")}`
        active.add(name)
        return { scene, name, outDir: join(scene, name) }
      } catch (error) {
        return { error }
      }
    })
    try {
      let results: RecordedScene<T>[]
      try {
        results = await run(folders.map((f) => ("outDir" in f ? f.outDir : undefined)))
      } catch (error) {
        results = folders.map(() => ({ ok: false, error }))
      }
      return folders.map((f, i): RecordedScene<StoredTake & { recorded: T }> => {
        if (!("outDir" in f)) return { ok: false, error: f.error }
        const result = results[i] ?? { ok: false, error: new Error("no result for this scene") }
        try {
          if (!result.ok) throw result.error
          return { ok: true, take: file(f.scene, f.outDir, result.take) }
        } catch (error) {
          discard(f.scene, f.name)
          return { ok: false, error }
        }
      })
    } finally {
      for (const f of folders) if ("name" in f) active.delete(f.name)
    }
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

  /** The scene's newest complete take (which one is current is M1-8's staleness rule). */
  latest(projectId: string, sceneId: string): StoredTake | undefined {
    return this.takes(projectId, sceneId)[0]
  }

  /** The take a composition names (`composition.take.key`), if it's still there. */
  take(projectId: string, sceneId: string, takeKey: string): StoredTake | undefined {
    if (!TAKE_KEY.test(takeKey)) return undefined
    return readTake(join(this.#sceneDir(projectId, sceneId), takeKey))
  }

  /**
   * Deletes every take of a scene, when the scene is deleted (never because a scene is missing from
   * the project for now: another git branch keeps its takes).
   */
  removeScene(projectId: string, sceneId: string): void {
    rmSync(this.#sceneDir(projectId, sceneId), { recursive: true, force: true })
  }

  /** Removes what recordings cut short by a crash left in a project's scenes (at the app's start). */
  sweepLeftovers(projectId: string): void {
    const project = join(this.root, "takes", ProjectId.parse(projectId))
    if (!existsSync(project)) return
    for (const entry of readdirSync(project, { withFileTypes: true })) {
      if (entry.isDirectory()) sweep(join(project, entry.name))
    }
  }
}

function file<T extends { meta: TakeMeta }>(
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

function readTake(dir: string): StoredTake | undefined {
  try {
    const meta = TakeMeta.parse(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")))
    return meta.outcome.status === "complete" ? { dir, meta } : undefined
  } catch {
    // not a take (or one written by an older Kiframe): not listed
    return undefined
  }
}

/**
 * A recording's folder and what the recorder makes next to it (`<name>.failed`, its staging folder
 * `.<name>.recording-…`). Best effort: a leftover is swept at the next start.
 */
function discard(scene: string, name: string): void {
  for (const entry of readdirSync(scene)) {
    if (entry === name || entry.startsWith(`${name}.`) || entry.startsWith(`.${name}.`)) {
      rmSync(join(scene, entry), { recursive: true, force: true })
    }
  }
}

/** Removes the hidden folders of a scene that aren't one of this process's recordings under way. */
function sweep(scene: string): void {
  for (const entry of readdirSync(scene)) {
    if (!entry.startsWith(".")) continue
    const owner = /^\.?(\.recording-[0-9a-f]{12})/.exec(entry)?.[1]
    if (owner !== undefined && active.has(owner)) continue
    try {
      rmSync(join(scene, entry), { recursive: true, force: true })
    } catch {
      // held (a process still writing): swept at the next start
    }
  }
}

function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}
