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
   * `recordScenario` outDir) and returns the take's meta. A complete take is filed under its key;
   * a failed or interrupted one is deleted with its raw frames (never left behind, never listed),
   * and `run`'s error is thrown.
   */
  async record(
    projectId: string,
    sceneId: string,
    run: (outDir: string) => Promise<{ meta: TakeMeta }>,
  ): Promise<StoredTake> {
    const scene = this.#sceneDir(projectId, sceneId)
    mkdirPrivate(scene)
    const outDir = join(scene, `.recording-${randomBytes(6).toString("hex")}`)
    const discard = () => {
      // The recorder keeps a failed take next to its folder (`<outDir>.failed`): gone too.
      rmSync(outDir, { recursive: true, force: true })
      rmSync(`${outDir}.failed`, { recursive: true, force: true })
    }
    let meta: TakeMeta
    try {
      meta = TakeMeta.parse((await run(outDir)).meta)
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
    renameSync(outDir, dir)
    chmodSync(dir, 0o700)
    return { dir, meta }
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
   * The scene's newest complete take, of its current scenario when `scenarioHash` is given (a take
   * of another scenario isn't this scene's take: the scene is stale).
   */
  latest(projectId: string, sceneId: string, scenarioHash?: string): StoredTake | undefined {
    return this.takes(projectId, sceneId).find(
      (t) => scenarioHash === undefined || t.meta.scenarioHash === scenarioHash,
    )
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

function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}
