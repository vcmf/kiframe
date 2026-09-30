import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  Composition,
  parseCompositionJson,
  parseProjectJson,
  parseScenarioYaml,
  parseSceneJson,
  Project,
  Scenario,
  Scene,
  SceneId,
} from "@kiframe/schema"
import { stringify } from "yaml"
import { jsonText, writeAtomic } from "./files.ts"

// A project folder on disk (docs/OBJECT-MODEL.md §0.7): objects only, never takes.
//   project.json
//   scenes/<sceneId>/scene.json, scenario.yaml, composition.json

/** The org of a project made without an account (the slice: no server yet). */
export const LOCAL_ORG = "local"

/** A scene as stored: its object and, for a recording, its scenario and composition. */
export interface StoredScene {
  scene: Scene
  scenario?: Scenario
  composition?: Composition
}

/** A scene folder that couldn't be read: reported, never dropping the rest of the project. */
export interface SceneProblem {
  sceneId: string
  message: string
}

export interface OpenedProject {
  dir: string
  project: Project
  scenes: Map<string, StoredScene>
  problems: SceneProblem[]
}

/** What a new project needs: its name and the app it shows. */
export interface NewProject {
  id: string
  name: string
  url: string
  viewport?: { width: number; height: number }
}

const sceneDir = (dir: string, id: string) => join(dir, "scenes", id)

/** Creates a project folder (refused if it already holds a project). */
export function createProject(dir: string, init: NewProject): OpenedProject {
  if (existsSync(join(dir, "project.json"))) {
    throw new Error(`${dir} already holds a project`)
  }
  const project = Project.parse({
    version: 1,
    id: init.id,
    orgId: LOCAL_ORG,
    name: init.name,
    target: {
      kind: "web",
      url: init.url,
      viewport: init.viewport ?? { width: 1440, height: 900 },
    },
  })
  mkdirSync(join(dir, "scenes"), { recursive: true })
  saveProject(dir, project)
  return { dir, project, scenes: new Map(), problems: [] }
}

/**
 * Opens a project folder. The project file must be valid (a SchemaError otherwise); a scene
 * folder that isn't is reported in `problems`, and the rest still opens.
 */
export function openProject(dir: string): OpenedProject {
  const project = parseProjectJson(readFileSync(join(dir, "project.json"), "utf8"))
  const scenes = new Map<string, StoredScene>()
  const problems: SceneProblem[] = []
  const root = join(dir, "scenes")
  const ids = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
    : []
  for (const id of ids) {
    try {
      scenes.set(id, readScene(dir, id))
    } catch (error) {
      problems.push({
        sceneId: id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  // The sequence names scenes that exist (a folder deleted by hand: reported, never a crash).
  for (const id of project.sequence) {
    if (!scenes.has(id) && !problems.some((p) => p.sceneId === id)) {
      problems.push({ sceneId: id, message: "in the sequence, but its folder is missing" })
    }
  }
  return { dir, project, scenes, problems }
}

function readScene(dir: string, id: string): StoredScene {
  const at = sceneDir(dir, id)
  const scene = parseSceneJson(readFileSync(join(at, "scene.json"), "utf8"))
  if (scene.id !== id) throw new Error(`scene.json has id "${scene.id}", its folder is "${id}"`)
  const stored: StoredScene = { scene }
  if (existsSync(join(at, "scenario.yaml"))) {
    stored.scenario = parseScenarioYaml(readFileSync(join(at, "scenario.yaml"), "utf8"))
  }
  if (existsSync(join(at, "composition.json"))) {
    stored.composition = parseCompositionJson(readFileSync(join(at, "composition.json"), "utf8"))
  }
  return stored
}

/** Writes the project file (validated first: an invalid project is never written). */
export function saveProject(dir: string, project: Project): void {
  writeAtomic(join(dir, "project.json"), jsonText(Project.parse(project)))
}

/**
 * Writes a scene (validated first), and adds it to the end of the sequence if it's new. A scenario
 * or composition left out is kept as it is on disk; `null` removes it.
 */
export function saveScene(
  opened: OpenedProject,
  scene: Scene,
  parts: { scenario?: Scenario | null; composition?: Composition | null } = {},
): void {
  const id = SceneId.parse(scene.id)
  const at = sceneDir(opened.dir, id)
  const valid = Scene.parse(scene)
  writeAtomic(join(at, "scene.json"), jsonText(valid))
  const previous = opened.scenes.get(id)
  const stored: StoredScene = { scene: valid }
  const scenario = parts.scenario === undefined ? previous?.scenario : parts.scenario
  const composition = parts.composition === undefined ? previous?.composition : parts.composition
  if (parts.scenario === null) rmSync(join(at, "scenario.yaml"), { force: true })
  else if (scenario !== undefined) {
    const s = Scenario.parse(scenario)
    if (parts.scenario !== undefined) writeAtomic(join(at, "scenario.yaml"), stringify(s))
    stored.scenario = s
  }
  if (parts.composition === null) rmSync(join(at, "composition.json"), { force: true })
  else if (composition !== undefined) {
    const c = Composition.parse(composition)
    if (parts.composition !== undefined) writeAtomic(join(at, "composition.json"), jsonText(c))
    stored.composition = c
  }
  opened.scenes.set(id, stored)
  opened.problems = opened.problems.filter((p) => p.sceneId !== id)
  if (!opened.project.sequence.includes(id)) {
    opened.project = { ...opened.project, sequence: [...opened.project.sequence, id] }
    saveProject(opened.dir, opened.project)
  }
}

/** Deletes a scene: its folder, and its place in the sequence and in outputs. */
export function removeScene(opened: OpenedProject, id: string): void {
  rmSync(sceneDir(opened.dir, SceneId.parse(id)), { recursive: true, force: true })
  opened.scenes.delete(id)
  opened.problems = opened.problems.filter((p) => p.sceneId !== id)
  opened.project = {
    ...opened.project,
    sequence: opened.project.sequence.filter((s) => s !== id),
    outputs: opened.project.outputs.map((o) =>
      o.include === undefined ? o : { ...o, include: o.include.filter((s) => s !== id) },
    ),
  }
  saveProject(opened.dir, opened.project)
}

/** Reorders the sequence: the same scenes, in a new order. */
export function reorderScenes(opened: OpenedProject, sequence: readonly string[]): void {
  const current = opened.project.sequence
  const same =
    sequence.length === current.length &&
    new Set(sequence).size === sequence.length &&
    sequence.every((id) => current.includes(id))
  if (!same) throw new Error("a new order has exactly the scenes of the sequence")
  opened.project = { ...opened.project, sequence: [...sequence] }
  saveProject(opened.dir, opened.project)
}
