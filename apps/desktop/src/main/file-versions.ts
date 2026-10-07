// The last versions of the project files the agent replaced or deleted (OBJECT-MODEL §0.13), kept
// in the app's data until history (M1-10) undoes them: a few per file, a project's whole kept
// bounded, the old ones gone after a while (a page may hold what the user wanted gone).
import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** Versions kept of one file. */
const PER_FILE = 5
/** A project's kept versions, all together (the oldest go first). */
const PER_PROJECT_BYTES = 200 * 1024 * 1024
/** How long a version is kept. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** The whole project's versions swept at most this often (a file's own: every time). */
const SWEEP_EVERY_MS = 60 * 1000

export class FileVersions {
  readonly #root: string
  readonly #maxBytes: number
  readonly #sweepEveryMs: number
  #count = 0
  #swept = -Infinity

  /** `root`: this project's folder of kept versions (in the app's data, by the host's scope). */
  constructor(root: string, options: { maxBytes?: number; sweepEveryMs?: number } = {}) {
    this.#root = root
    this.#maxBytes = options.maxBytes ?? PER_PROJECT_BYTES
    this.#sweepEveryMs = options.sweepEveryMs ?? SWEEP_EVERY_MS
  }

  /** Keeps `bytes`, the version of `path` about to be replaced or deleted (a throw: nothing is). */
  keep(path: string, bytes: Uint8Array): void {
    const dir = join(this.#root, createHash("sha256").update(path).digest("hex").slice(0, 32))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "path.txt"), path)
    // The time, then a counter: two versions in one millisecond never share a name.
    const name = `${String(Date.now()).padStart(15, "0")}-${String(this.#count++).padStart(6, "0")}.bin`
    writeFileSync(join(dir, name), bytes)
    // Kept: tidying is best effort (a failure there never refuses the write it was kept for).
    try {
      this.#tidy(dir)
    } catch {
      // the next keep tidies
    }
  }

  /**
   * At most `PER_FILE` here; the whole project (every file's versions read: on the main process,
   * so not at every write) none older than `MAX_AGE_MS`, under its bound.
   */
  #tidy(dir: string): void {
    const now = Date.now()
    const versions = (folder: string) =>
      readdirSync(folder)
        .filter((n) => n.endsWith(".bin"))
        .sort()
        .map((n) => ({ file: join(folder, n), name: n, at: Number(n.slice(0, 15)) }))
    for (const old of versions(dir).slice(0, -PER_FILE)) rmSync(old.file, { force: true })
    if (now - this.#swept < this.#sweepEveryMs) return
    this.#swept = now
    const all = readdirSync(this.#root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => versions(join(this.#root, e.name)))
      .map((v) => ({ ...v, size: statSync(v.file).size }))
      // By name (its time, then its counter): versions of one millisecond keep their order.
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    let total = all.reduce((sum, v) => sum + v.size, 0)
    for (const v of all) {
      if (now - v.at <= MAX_AGE_MS && total <= this.#maxBytes) break
      rmSync(v.file, { force: true })
      total -= v.size
    }
  }
}
