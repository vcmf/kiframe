// What a project folder says for the take store's bookkeeping, read only (never opened as the
// user's project: no temporary file of another process removed). Synchronous on purpose: it runs
// in a worker thread (folder-worker.ts), where a stuck network mount can't freeze the app.
// Electron-free.
import { existsSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { openProject } from "@kiframe/project"

/** A folder a project was opened from, and the device it was on then (unknown: never "gone"). */
export interface Folder {
  path: string
  dev?: number | undefined
}

/**
 * `here`: the project is there; per scene, the take key its composition names, and the scenes
 * that didn't read. `gone`: not there (or another project now) while the filesystem it was on is
 * still mounted where it was. `unknown`: can't tell (an unplugged drive or share, unreadable).
 */
export type FolderState =
  | { state: "here"; scenes: Record<string, string>; unread: string[] }
  | { state: "gone" }
  | { state: "unknown"; why: string }

export function inspectFolder(folder: Folder, projectId: string): FolderState {
  if (folder.dev === undefined) return { state: "unknown", why: "its device wasn't recorded" }
  if (!existsSync(join(folder.path, "project.json"))) {
    return onItsDevice(folder) ? { state: "gone" } : { state: "unknown", why: "not mounted" }
  }
  let opened: ReturnType<typeof openProject>
  try {
    opened = openProject(folder.path, { tidy: false })
  } catch (error) {
    return { state: "unknown", why: error instanceof Error ? error.message : String(error) }
  }
  // Another project in its place (deleted, a new one made there): this one is gone from it.
  if (opened.project.id !== projectId) {
    return onItsDevice(folder) ? { state: "gone" } : { state: "unknown", why: "not mounted" }
  }
  const scenes: Record<string, string> = {}
  for (const [id, stored] of opened.scenes) {
    const key = stored.composition?.take?.key
    if (key !== undefined) scenes[id] = key
  }
  const unread = [...new Set(opened.problems.map((p) => p.sceneId))]
  return { state: "here", scenes, unread }
}

/** Whether the nearest folder above it exists on the device the project was on. */
function onItsDevice(folder: Folder): boolean {
  for (let at = dirname(folder.path); ; at = dirname(at)) {
    try {
      return statSync(at).dev === folder.dev
    } catch {
      if (dirname(at) === at) return false
    }
  }
}
