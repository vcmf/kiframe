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

export class TakeStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
  }

  #sceneDir(projectId: string, sceneId: string): string {
    return join(this.root, "takes", ProjectId.parse(projectId), SceneId.parse(sceneId))
  }

  /** A private folder to record a new take into (the recorder writes it, then `keep` files it). */
  recordingDir(projectId: string, sceneId: string): string {
    const scene = this.#sceneDir(projectId, sceneId)
    mkdirPrivate(scene)
    return join(scene, `.recording-${randomBytes(6).toString("hex")}`)
  }

  /** Files a recorded take under its key (from its meta.json). */
  keep(recorded: string): StoredTake {
    const meta = TakeMeta.parse(JSON.parse(readFileSync(join(recorded, "meta.json"), "utf8")))
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(meta.takeKey))
      throw new Error("take key isn't a folder name")
    const dir = join(recorded, "..", meta.takeKey)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    renameSync(recorded, dir)
    chmodSync(dir, 0o700)
    return { dir, meta }
  }

  /** The scene's takes, newest first (complete ones only; a failed or interrupted one is skipped). */
  takes(projectId: string, sceneId: string): StoredTake[] {
    const scene = this.#sceneDir(projectId, sceneId)
    if (!existsSync(scene)) return []
    const out: StoredTake[] = []
    for (const entry of readdirSync(scene, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const dir = join(scene, entry.name)
      try {
        const meta = TakeMeta.parse(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")))
        if (meta.outcome.status === "complete") out.push({ dir, meta })
      } catch {
        // not a take (or one written by an older Kiframe): not listed
      }
    }
    return out.sort((a, b) => b.meta.recordedAt.localeCompare(a.meta.recordedAt))
  }

  /** The scene's newest complete take, if any. */
  latest(projectId: string, sceneId: string): StoredTake | undefined {
    return this.takes(projectId, sceneId)[0]
  }
}

function mkdirPrivate(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}
