// The open project: one at a time, opened or created from a folder main chose (never a path the
// window sent), and shown to the window as a `ProjectView`.
import { randomBytes } from "node:crypto"
import { createProject, openProject, type OpenedProject } from "@kiframe/project"
import type { ProjectView, SceneView } from "../shared/ipc.ts"

/** A project folder's extension (a new project's folder gets it). */
export const PROJECT_EXTENSION = ".kiframe"

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
    const opened = openProject(dir)
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

/** The project as the window shows it: the scenes in story order, then any outside the sequence. */
export function projectView(opened: OpenedProject): ProjectView {
  const { project, scenes, problems } = opened
  const unreadable = new Set(problems.filter((p) => p.part === "scene").map((p) => p.sceneId))
  // The sequence, then the folders outside it (read or not: an unreadable one is shown too).
  const ids = [...new Set([...project.sequence, ...scenes.keys(), ...unreadable])]
  const views: SceneView[] = []
  for (const id of ids) {
    const stored = scenes.get(id)
    if (stored === undefined) {
      if (unreadable.has(id))
        views.push({ id, title: id, kind: "unreadable", status: "unreadable" })
      continue
    }
    const { scene } = stored
    if (scene.source.kind === "card") {
      views.push({ id, title: scene.title, kind: "card", status: "card" })
      continue
    }
    const status =
      stored.composition !== undefined
        ? "recorded"
        : stored.scenario !== undefined
          ? "grounded"
          : "empty"
    views.push({ id, title: scene.title, kind: "recording", status })
  }
  return {
    name: project.name,
    dir: opened.dir,
    url: project.target.url ?? null,
    scenes: views,
    problems: problems.map((p) => `${p.sceneId}: ${p.message}`),
  }
}
