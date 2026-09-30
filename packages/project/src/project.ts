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
import { jsonText, removeStrayTemps, writeAtomic } from "./files.ts"

// A project folder on disk (docs/OBJECT-MODEL.md §0.7): objects only, never takes.
//   project.json
//   scenes/<sceneId>/scene.json, scenario.yaml, composition.json
// One writer per project (the app's main process); a change made on disk by anyone else since the
// project was read (a hand edit, a git pull) is never overwritten: `ProjectChangedError`.

/** The org of a project made without an account (the slice: no server yet). */
export const LOCAL_ORG = "local"

/** A scene as stored: its object and, for a recording, its scenario and composition. */
export interface StoredScene {
  scene: Scene
  scenario?: Scenario
  composition?: Composition
}

/** Something wrong in the folder: reported, never dropping the rest of the project. */
export interface SceneProblem {
  sceneId: string
  message: string
}

export interface OpenedProject {
  dir: string
  project: Project
  scenes: Map<string, StoredScene>
  problems: SceneProblem[]
  /** project.json as last read or written by this handle (a save checks the file still says it). */
  diskText: string
}

/** project.json changed on disk since this handle read it: reopen, then apply the change again. */
export class ProjectChangedError extends Error {
  constructor(dir: string) {
    super(`${dir}/project.json changed on disk since it was opened: reopen the project`)
    this.name = "ProjectChangedError"
  }
}

/** What a new project needs: its name and the app it shows. */
export interface NewProject {
  id: string
  name: string
  url: string
  viewport?: { width: number; height: number }
}

const sceneDir = (dir: string, id: string) => join(dir, "scenes", id)
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Creates a project folder (refused if it already holds a project). */
export function createProject(dir: string, init: NewProject): OpenedProject {
  const file = join(dir, "project.json")
  if (existsSync(file)) throw new Error(`${dir} already holds a project`)
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
  const text = jsonText(project)
  writeAtomic(file, text)
  return { dir, project, scenes: new Map(), problems: [], diskText: text }
}

/**
 * Opens a project folder. The project file must be valid (a SchemaError otherwise); a scene folder
 * that isn't, one the sequence names but that's missing, or one outside the sequence is reported in
 * `problems`, and the rest still opens.
 */
export function openProject(dir: string): OpenedProject {
  removeStrayTemps(dir)
  const diskText = readFileSync(join(dir, "project.json"), "utf8")
  const project = parseProjectJson(diskText)
  const scenes = new Map<string, StoredScene>()
  const problems: SceneProblem[] = []
  const root = join(dir, "scenes")
  const ids = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
    : []
  for (const id of ids) {
    removeStrayTemps(sceneDir(dir, id))
    try {
      scenes.set(id, readScene(dir, id))
    } catch (error) {
      problems.push({ sceneId: id, message: errorText(error) })
    }
    if (!project.sequence.includes(id)) {
      problems.push({ sceneId: id, message: "a scene folder that isn't in the sequence" })
    }
  }
  for (const id of project.sequence) {
    if (!ids.includes(id)) {
      problems.push({ sceneId: id, message: "in the sequence, but its folder is missing" })
    }
  }
  return { dir, project, scenes, problems, diskText }
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

/**
 * Writes the project file: validated first (an invalid project is never written), and only if the
 * file still says what this handle last read or wrote (`ProjectChangedError` otherwise).
 */
export function saveProject(opened: OpenedProject, project: Project): void {
  const file = join(opened.dir, "project.json")
  const onDisk = existsSync(file) ? readFileSync(file, "utf8") : undefined
  if (onDisk !== opened.diskText) throw new ProjectChangedError(opened.dir)
  const text = jsonText(Project.parse(project))
  writeAtomic(file, text)
  opened.project = project
  opened.diskText = text
}

/**
 * Writes a scene: every part validated before anything is written. A new scene joins the end of
 * the sequence (the project file first: a crash then leaves a scene the sequence names but without
 * its folder, reported on open). A part left out stays as it is on disk; `null` removes it. A scene
 * with a problem on open (a part that didn't read) is saved only with both parts given.
 */
export function saveScene(
  opened: OpenedProject,
  scene: Scene,
  parts: { scenario?: Scenario | null; composition?: Composition | null } = {},
): void {
  const id = SceneId.parse(scene.id)
  const broken = opened.problems.some((p) => p.sceneId === id && !opened.scenes.has(id))
  if (broken && (parts.scenario === undefined || parts.composition === undefined)) {
    throw new Error(
      `scene "${id}" didn't read: save it with its scenario and composition (or null)`,
    )
  }
  // Validated first, all of it.
  const valid = Scene.parse(scene)
  const scenario = parts.scenario == null ? parts.scenario : Scenario.parse(parts.scenario)
  const composition =
    parts.composition == null ? parts.composition : Composition.parse(parts.composition)
  if (!opened.project.sequence.includes(id)) {
    saveProject(opened, { ...opened.project, sequence: [...opened.project.sequence, id] })
  }
  const at = sceneDir(opened.dir, id)
  writeAtomic(join(at, "scene.json"), jsonText(valid))
  if (scenario === null) rmSync(join(at, "scenario.yaml"), { force: true })
  else if (scenario !== undefined) writeAtomic(join(at, "scenario.yaml"), stringify(scenario))
  if (composition === null) rmSync(join(at, "composition.json"), { force: true })
  else if (composition !== undefined) {
    writeAtomic(join(at, "composition.json"), jsonText(composition))
  }
  const previous = opened.scenes.get(id)
  const stored: StoredScene = { scene: valid }
  const keptScenario = scenario === undefined ? previous?.scenario : (scenario ?? undefined)
  const keptComposition =
    composition === undefined ? previous?.composition : (composition ?? undefined)
  if (keptScenario !== undefined) stored.scenario = keptScenario
  if (keptComposition !== undefined) stored.composition = keptComposition
  opened.scenes.set(id, stored)
  opened.problems = opened.problems.filter((p) => p.sceneId !== id)
}

/**
 * Deletes a scene: its place in the sequence and outputs first (the project file), then its folder
 * (a crash in between leaves a folder outside the sequence, reported on open). Its takes are the
 * take store's (`TakeStore.removeScene`).
 */
export function removeScene(opened: OpenedProject, id: string): void {
  const valid = SceneId.parse(id)
  saveProject(opened, {
    ...opened.project,
    sequence: opened.project.sequence.filter((s) => s !== valid),
    outputs: opened.project.outputs.map((o) =>
      o.include === undefined ? o : { ...o, include: o.include.filter((s) => s !== valid) },
    ),
  })
  rmSync(sceneDir(opened.dir, valid), { recursive: true, force: true })
  opened.scenes.delete(valid)
  opened.problems = opened.problems.filter((p) => p.sceneId !== valid)
}

/** Reorders the sequence: the same scenes, in a new order. */
export function reorderScenes(opened: OpenedProject, sequence: readonly string[]): void {
  const current = opened.project.sequence
  const same =
    sequence.length === current.length &&
    new Set(sequence).size === sequence.length &&
    sequence.every((id) => current.includes(id))
  if (!same) throw new Error("a new order has exactly the scenes of the sequence")
  saveProject(opened, { ...opened.project, sequence: [...sequence] })
}
