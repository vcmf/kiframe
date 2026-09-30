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

export interface StoredTake {
  dir: string
  meta: TakeMeta
}

/** A take key as a folder name (the recorder's keys: a hash and a timestamp). */
const TAKE_KEY = /^[A-Za-z0-9_-]{1,128}$/

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
   * `recordScenario` outDir) and returns what it recorded (its take, with its warnings). A complete
   * take is filed under its key; a failed or interrupted one is deleted with its raw frames (never
   * left behind, never listed), and `run`'s error is thrown. Leftovers of a recording a crash cut
   * short are swept first.
   */
  async record<T extends { meta: TakeMeta }>(
    projectId: string,
    sceneId: string,
    run: (outDir: string) => Promise<T>,
  ): Promise<StoredTake & { recorded: T }> {
    const scene = this.#sceneDir(projectId, sceneId)
    mkdirPrivate(scene)
    sweep(scene)
    const outDir = join(scene, `.recording-${randomBytes(6).toString("hex")}`)
    const discard = () => {
      // The recorder keeps a failed take next to its folder (`<outDir>.failed`): gone too.
      rmSync(outDir, { recursive: true, force: true })
      rmSync(`${outDir}.failed`, { recursive: true, force: true })
    }
    let meta: TakeMeta
    let recorded: T
    try {
      recorded = await run(outDir)
      meta = TakeMeta.parse(recorded.meta)
    } catch (error) {
      discard()
      throw error
    }
    if (meta.outcome.status !== "complete" || !TAKE_KEY.test(meta.takeKey)) {
      discard()
      throw new Error("the recording didn't produce a complete take")
    }
    const dir = join(scene, meta.takeKey)
    if (existsSync(dir)) {
      // Keys carry the recording time: a clash is a bug, never a take to overwrite.
      discard()
      throw new Error(`a take "${meta.takeKey}" already exists`)
    }
    try {
      renameSync(outDir, dir)
      chmodSync(dir, 0o700)
    } catch (error) {
      discard()
      throw error
    }
    return { dir, meta, recorded }
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
   * runtime's `takeKeyPrefix` of the scene's scenario and project now: another scenario, app or
   * capture setting isn't this scene's take, the scene is stale). Only the folders it needs are
   * read (a key ends with its recording time).
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

  /** Deletes every take of a scene (with the scene: a new scene of that id never gets them). */
  removeScene(projectId: string, sceneId: string): void {
    rmSync(this.#sceneDir(projectId, sceneId), { recursive: true, force: true })
  }

  /**
   * Deletes the takes of every scene not in `sceneIds` (the project's scenes, on open: a scene
   * removed while its takes weren't, a crash in between), and the leftovers of cut-short
   * recordings.
   */
  pruneScenes(projectId: string, sceneIds: readonly string[]): void {
    const project = join(this.root, "takes", ProjectId.parse(projectId))
    if (!existsSync(project)) return
    for (const entry of readdirSync(project, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (sceneIds.includes(entry.name)) sweep(join(project, entry.name))
      else rmSync(join(project, entry.name), { recursive: true, force: true })
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

/** Removes what cut-short recordings left in a scene's folder (hidden: never a filed take). */
function sweep(scene: string): void {
  for (const entry of readdirSync(scene, { withFileTypes: true })) {
    if (entry.name.startsWith("."))
      rmSync(join(scene, entry.name), { recursive: true, force: true })
  }
}

function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}
