// What a project folder says for the take store's bookkeeping, read only (never opened as the
// user's project: no temporary file of another process removed). Synchronous on purpose: it runs
// in a worker thread (folder-worker.ts), where a stuck network mount can't freeze the app.
// Electron-free.
import { statSync } from "node:fs"
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
  // Gone only when the folder itself isn't there: one still there in any form (its project file
  // missing, another project, a git branch without it, an evicted cloud file) is unknown.
  const folderThere = presence(folder.path)
  if (folderThere === "absent") return goneOrUnknown(folder)
  if (folderThere === "unknown") return { state: "unknown", why: "it can't be read (a permission)" }
  const there = presence(join(folder.path, "project.json"))
  if (there !== "there") return { state: "unknown", why: "its project file isn't there" }
  let opened: ReturnType<typeof openProject>
  try {
    opened = openProject(folder.path, { tidy: false })
  } catch (error) {
    return { state: "unknown", why: error instanceof Error ? error.message : String(error) }
  }
  // Another project in its place (a new one made there, a branch): unknown, never gone.
  if (opened.project.id !== projectId) return { state: "unknown", why: "another project is there" }
  const scenes: Record<string, string> = {}
  for (const [id, stored] of opened.scenes) {
    const key = stored.composition?.take?.key
    if (key !== undefined) scenes[id] = key
  }
  // Only a part that didn't read (a scene outside the sequence reads fine: its takes may go).
  const unread = [
    ...new Set(opened.problems.filter((p) => p.part !== undefined).map((p) => p.sceneId)),
  ]
  return { state: "here", scenes, unread }
}

/**
 * The folder not there: gone only when the nearest folder above it is on the device the project was on (its
 * filesystem still mounted there) and no git working tree holds it (a branch without the project
 * brings it back on checkout: never counted as removed). Else unknown.
 */
function goneOrUnknown(folder: Folder): FolderState {
  for (let at = dirname(folder.path); ; at = dirname(at)) {
    let dev: number
    try {
      dev = statSync(at).dev
    } catch (error) {
      // Only "no such folder" walks up: any other error (a permission) can't tell.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at) {
        return { state: "unknown", why: "its surroundings can't be read" }
      }
      continue
    }
    if (dev !== folder.dev) return { state: "unknown", why: "not mounted" }
    if (inGitTree(at)) return { state: "unknown", why: "in a git working tree (another branch?)" }
    return { state: "gone" }
  }
}

/** Whether a folder or one above it is a git working tree. */
function inGitTree(dir: string): boolean {
  for (let at = dir; ; at = dirname(at)) {
    if (presence(join(at, ".git")) !== "absent") return true
    if (dirname(at) === at) return false
  }
}

/** A path there, absent (no such file: only that), or unknown (any other error). */
function presence(path: string): "there" | "absent" | "unknown" {
  try {
    statSync(path)
    return "there"
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"
  }
}
