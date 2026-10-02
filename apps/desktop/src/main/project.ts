// The open project: one at a time, opened or created from a folder main chose (never a path the
// window sent), and shown to the window as a `ProjectView`.
import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import { createProject, openProject, type OpenedProject } from "@kiframe/project"
import { TargetApp } from "@kiframe/schema"
import type { ProjectView, SceneView } from "../shared/ipc.ts"

/** A project folder's extension (a new project's folder gets it). */
export const PROJECT_EXTENSION = ".kiframe"

/** The app's address, by the project schema's own rule (http(s), no credentials in it). */
export function targetUrl(url: string): string {
  const parsed = TargetApp.shape.url.safeParse(url.trim())
  if (!parsed.success) {
    throw new Error(`App address: ${parsed.error.issues[0]?.message ?? "not a URL"}`)
  }
  return parsed.data
}

/** Names Windows refuses as a file name: a device name before the first dot (`nul.tar` too). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i
/** Bytes a folder name may hold: 255 on most file systems, the extension included. */
const MAX_NAME_BYTES = 255 - Buffer.byteLength(PROJECT_EXTENSION)

/**
 * A project name as a folder name: no separators, characters or names a file system refuses, no
 * leading dots or spaces, and short enough in bytes.
 */
export function projectFileName(name: string): string {
  let safe = name
    // Separators, characters Windows refuses, and control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    // A trailing dot or space: Windows drops it (`con.` is `con`).
    .replace(/[.\s]+$/, "")
  if (RESERVED.test(safe)) safe = `${safe.replace(/^([^.]*)/, "$1 project")}`
  while (Buffer.byteLength(safe) > MAX_NAME_BYTES) safe = [...safe].slice(0, -1).join("").trimEnd()
  return `${safe === "" ? "Untitled" : safe}${PROJECT_EXTENSION}`
}

/**
 * The folder a new project goes in, from the path the user picked (the extension added if it
 * wasn't): refused unless it's new or empty (never mixed into a folder holding other files).
 */
export function newProjectDir(picked: string): string {
  const dir = picked.toLowerCase().endsWith(PROJECT_EXTENSION)
    ? picked
    : `${picked}${PROJECT_EXTENSION}`
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) {
    throw new Error(`${dir} already exists and isn't an empty folder: pick another name`)
  }
  return dir
}

export class ProjectSession {
  #opened: OpenedProject | null = null

  get opened(): OpenedProject | null {
    return this.#opened
  }

  /** Creates a project in `dir` and makes it the open one. */
  create(dir: string, init: { name: string; url: string }): OpenedProject {
    const opened = createProject(dir, {
      id: `p-${randomBytes(8).toString("hex")}`,
      name: init.name,
      url: init.url,
    })
    this.#opened = opened
    return opened
  }

  /** Opens the project in `dir` (its errors say why it doesn't read) and makes it the open one. */
  open(dir: string): OpenedProject {
    return this.use(this.peek(dir))
  }

  /** Opens the project in `dir` without making it the open one yet. */
  peek(dir: string): OpenedProject {
    return openProject(dir)
  }

  /** Makes an opened project the open one. */
  use(opened: OpenedProject): OpenedProject {
    this.#opened = opened
    return opened
  }

  close(): void {
    this.#opened = null
  }

  view(): ProjectView | null {
    return this.#opened === null ? null : projectView(this.#opened)
  }
}

/**
 * The project as the window shows it: the scenes in story order, then any outside the sequence.
 * Nothing wrong is hidden: a scene with a part that didn't read, or whose folder is missing, says
 * so, and every problem is listed.
 */
export function projectView(opened: OpenedProject): ProjectView {
  const { project, scenes, problems } = opened
  const problemsOf = (id: string) => problems.filter((p) => p.sceneId === id)
  const ids = [
    ...new Set([...project.sequence, ...scenes.keys(), ...problems.map((p) => p.sceneId)]),
  ]
  const views: SceneView[] = []
  for (const id of ids) {
    const stored = scenes.get(id)
    const broken = problemsOf(id).filter((p) => p.part !== undefined)
    const problem = broken.map((p) => p.message).join("; ")
    if (stored === undefined) {
      const missing = project.sequence.includes(id) && broken.length === 0
      views.push({
        id,
        title: id,
        status: missing ? "missing" : "unreadable",
        ...(problem !== "" && { problem }),
      })
      continue
    }
    const { scene } = stored
    if (broken.length > 0) {
      views.push({ id, title: scene.title, status: "unreadable", problem })
      continue
    }
    if (scene.source.kind === "card") {
      views.push({ id, title: scene.title, status: "card" })
      continue
    }
    const status =
      stored.composition !== undefined
        ? "recorded"
        : stored.scenario !== undefined
          ? "grounded"
          : "empty"
    views.push({ id, title: scene.title, status })
  }
  return {
    name: project.name,
    dir: opened.dir,
    url: project.target.url ?? null,
    scenes: views,
    problems: problems.map((p) => `${p.sceneId}: ${p.message}`),
  }
}
