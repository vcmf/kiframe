// The host's own ids (SECRETS-DESIGN §3 A1): an approval scope per project folder and a key per
// scene, kept in app data, never in the project (which the agent writes and a copy duplicates).
import { randomBytes } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"

const Entry = z.strictObject({
  scope: z.string().regex(/^folder-[0-9a-f]{16}$/),
  scenes: z.record(z.string(), z.string().regex(/^scene-[0-9a-f]{12}$/)),
})
const File = z.strictObject({ version: z.literal(1), projects: z.record(z.string(), Entry) })
type File = z.infer<typeof File>

export class Registry {
  readonly #path: string
  #file: File

  /** `dir`: app data. A registry that doesn't read is said, never replaced (approvals hang on it). */
  constructor(dir: string) {
    this.#path = join(dir, "registry.json")
    this.#file = existsSync(this.#path)
      ? File.parse(JSON.parse(readFileSync(this.#path, "utf8")))
      : { version: 1, projects: {} }
  }

  /** The project folder's scope (made on first use; a moved folder is a new one). */
  scope(dir: string): string {
    return this.#entry(dir).scope
  }

  /** The scene's key in the project folder: stable for it (kebab-case, a SceneId). */
  sceneKey(dir: string, sceneId: string): string {
    const entry = this.#entry(dir)
    // Own keys only (a scene named "constructor" is a scene, not Object's).
    const known = Object.hasOwn(entry.scenes, sceneId) ? entry.scenes[sceneId] : undefined
    if (known !== undefined) return known
    const key = `scene-${randomBytes(6).toString("hex")}`
    entry.scenes[sceneId] = key
    this.#save()
    return key
  }

  /**
   * A scene removed: its key goes with it (a new scene reusing the id gets a new key, so it never
   * inherits the old one's approvals).
   */
  forgetScene(dir: string, sceneId: string): void {
    const entry = this.#entry(dir)
    if (!Object.hasOwn(entry.scenes, sceneId)) return
    delete entry.scenes[sceneId]
    this.#save()
  }

  #entry(dir: string): z.infer<typeof Entry> {
    const at = realpathSync(dir)
    let entry = Object.hasOwn(this.#file.projects, at) ? this.#file.projects[at] : undefined
    if (entry === undefined) {
      entry = { scope: `folder-${randomBytes(8).toString("hex")}`, scenes: {} }
      this.#file.projects[at] = entry
      this.#save()
    }
    return entry
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    const tmp = `${this.#path}.${randomBytes(6).toString("hex")}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.#file, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.#path)
  }
}
