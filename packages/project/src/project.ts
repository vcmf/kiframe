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
// One writer per project (the app's main process). A file changed on disk by anyone else since this
// handle read or wrote it (a hand edit, a git pull) is never overwritten: `ProjectChangedError`.

/** The org of a project made without an account (the slice: no server yet). */
export const LOCAL_ORG = "local"

/** The parts of a scene folder. */
export type ScenePart = "scene" | "scenario" | "composition"

/** A scene as stored: its object and, for a recording, its scenario and composition. */
export interface StoredScene {
  scene: Scene
  scenario?: Scenario
  composition?: Composition
}

/** Something wrong in the folder: reported, never dropping the rest of the project. */
export interface SceneProblem {
  sceneId: string
  /** The part that didn't read, when it's one. */
  part?: ScenePart
  message: string
}

export interface OpenedProject {
  dir: string
  project: Project
  scenes: Map<string, StoredScene>
  problems: SceneProblem[]
  /** Every file this handle read or wrote, as it was then (a path: absent when it didn't exist). */
  disk: Map<string, string>
}

/** A file changed on disk since this handle read it: reopen the project, then redo the change. */
export class ProjectChangedError extends Error {
  constructor(file: string) {
    super(`${file} changed on disk since the project was opened: reopen it`)
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

const FILES: Record<ScenePart, string> = {
  scene: "scene.json",
  scenario: "scenario.yaml",
  composition: "composition.json",
}
const PROJECT_FILE = "project.json"
const scenePath = (id: string, part: ScenePart) => join("scenes", id, FILES[part])
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function readKnown(dir: string, disk: Map<string, string>, rel: string): string | undefined {
  const path = join(dir, rel)
  if (!existsSync(path)) {
    disk.delete(rel)
    return undefined
  }
  const text = readFileSync(path, "utf8")
  disk.set(rel, text)
  return text
}

/** Refuses to touch a file that changed since this handle last saw it. */
function assertUnchanged(opened: OpenedProject, rel: string): void {
  const path = join(opened.dir, rel)
  const now = existsSync(path) ? readFileSync(path, "utf8") : undefined
  if (now !== opened.disk.get(rel)) throw new ProjectChangedError(rel)
}

function write(opened: OpenedProject, rel: string, text: string): void {
  writeAtomic(join(opened.dir, rel), text)
  opened.disk.set(rel, text)
}

function remove(opened: OpenedProject, rel: string): void {
  rmSync(join(opened.dir, rel), { force: true })
  opened.disk.delete(rel)
}

/** Creates a project folder (refused if it already holds a project). */
export function createProject(dir: string, init: NewProject): OpenedProject {
  if (existsSync(join(dir, PROJECT_FILE))) throw new Error(`${dir} already holds a project`)
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
  const opened: OpenedProject = { dir, project, scenes: new Map(), problems: [], disk: new Map() }
  write(opened, PROJECT_FILE, jsonText(project))
  return opened
}

/**
 * Opens a project folder. The project file must be valid (a SchemaError otherwise). A scene part
 * that doesn't read, a folder the sequence names but that's missing, or one outside the sequence
 * is reported in `problems`; the rest still opens (a scene's other parts included).
 */
export function openProject(dir: string): OpenedProject {
  removeStrayTemps(dir)
  const disk = new Map<string, string>()
  const project = parseProjectJson(readKnown(dir, disk, PROJECT_FILE) ?? "")
  const scenes = new Map<string, StoredScene>()
  const problems: SceneProblem[] = []
  const root = join(dir, "scenes")
  const ids = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
    : []
  for (const id of ids) {
    removeStrayTemps(join(root, id))
    const stored = readScene(dir, disk, id, problems)
    if (stored !== undefined) scenes.set(id, stored)
    if (!project.sequence.includes(id)) {
      problems.push({ sceneId: id, message: "a scene folder that isn't in the sequence" })
    }
  }
  for (const id of project.sequence) {
    if (!ids.includes(id)) {
      problems.push({ sceneId: id, message: "in the sequence, but its folder is missing" })
    }
  }
  return { dir, project, scenes, problems, disk }
}

/** Reads each part on its own: one that doesn't read is reported, the others still load. */
function readScene(
  dir: string,
  disk: Map<string, string>,
  id: string,
  problems: SceneProblem[],
): StoredScene | undefined {
  const part = <T>(which: ScenePart, parse: (text: string) => T): T | undefined => {
    try {
      const text = readKnown(dir, disk, scenePath(id, which))
      return text === undefined ? undefined : parse(text)
    } catch (error) {
      problems.push({ sceneId: id, part: which, message: errorText(error) })
      return undefined
    }
  }
  const scene = part("scene", (text) => {
    const s = parseSceneJson(text)
    if (s.id !== id) throw new Error(`scene.json has id "${s.id}", its folder is "${id}"`)
    return s
  })
  const scenario = part("scenario", parseScenarioYaml)
  const composition = part("composition", parseCompositionJson)
  if (scene === undefined) {
    if (!problems.some((p) => p.sceneId === id && p.part === "scene")) {
      problems.push({ sceneId: id, part: "scene", message: "scene.json is missing" })
    }
    return undefined
  }
  return {
    scene,
    ...(scenario !== undefined && { scenario }),
    ...(composition !== undefined && { composition }),
  }
}

/** Writes the project file: validated first, and only over the version this handle last saw. */
export function saveProject(opened: OpenedProject, project: Project): void {
  // The handle keeps what's on disk (defaults filled in; never the caller's object).
  const valid = Project.parse(project)
  assertUnchanged(opened, PROJECT_FILE)
  write(opened, PROJECT_FILE, jsonText(valid))
  opened.project = valid
}

/**
 * Writes a scene: every part validated, and every file it touches checked unchanged since this
 * handle saw it, before anything is written. A new scene joins the end of the sequence (the project
 * file first: a crash then leaves a scene the sequence names but without its folder, reported on
 * open). A part left out stays as it is on disk; `null` removes it. A part that didn't read on
 * open must be given (or removed with `null`).
 */
export function saveScene(
  opened: OpenedProject,
  scene: Scene,
  parts: { scenario?: Scenario | null; composition?: Composition | null } = {},
): void {
  const id = SceneId.parse(scene.id)
  const broken = opened.problems.filter((p) => p.sceneId === id && p.part !== undefined)
  for (const { part } of broken) {
    if (part === undefined || part === "scene") continue
    if (parts[part] === undefined) {
      throw new Error(`scene "${id}": its ${FILES[part]} didn't read: give it (or null)`)
    }
  }
  // Validated first, all of it.
  const valid = Scene.parse(scene)
  const scenario = parts.scenario == null ? parts.scenario : Scenario.parse(parts.scenario)
  const composition =
    parts.composition == null ? parts.composition : Composition.parse(parts.composition)
  // Nothing changed on disk behind this handle (a broken part is replaced: it's checked too).
  const touched: ScenePart[] = ["scene"]
  if (scenario !== undefined) touched.push("scenario")
  if (composition !== undefined) touched.push("composition")
  for (const which of touched) assertUnchanged(opened, scenePath(id, which))
  // (A new scene: saveProject checks project.json, still before any write.)
  if (!opened.project.sequence.includes(id)) {
    saveProject(opened, { ...opened.project, sequence: [...opened.project.sequence, id] })
  }
  write(opened, scenePath(id, "scene"), jsonText(valid))
  if (scenario === null) remove(opened, scenePath(id, "scenario"))
  else if (scenario !== undefined) write(opened, scenePath(id, "scenario"), stringify(scenario))
  if (composition === null) remove(opened, scenePath(id, "composition"))
  else if (composition !== undefined) {
    write(opened, scenePath(id, "composition"), jsonText(composition))
  }
  const previous = opened.scenes.get(id)
  const keptScenario = scenario === undefined ? previous?.scenario : (scenario ?? undefined)
  const keptComposition =
    composition === undefined ? previous?.composition : (composition ?? undefined)
  opened.scenes.set(id, {
    scene: valid,
    ...(keptScenario !== undefined && { scenario: keptScenario }),
    ...(keptComposition !== undefined && { composition: keptComposition }),
  })
  opened.problems = opened.problems.filter((p) => p.sceneId !== id)
}

/**
 * Deletes a scene: its place in the sequence and outputs first (the project file), then its folder
 * (a crash in between leaves a folder outside the sequence, reported on open). Its takes stay in
 * the take store (another git branch may still name them; retention is M1-8's).
 */
export function removeScene(opened: OpenedProject, id: string): void {
  const valid = SceneId.parse(id)
  for (const which of Object.keys(FILES) as ScenePart[]) {
    assertUnchanged(opened, scenePath(valid, which))
  }
  saveProject(opened, {
    ...opened.project,
    sequence: opened.project.sequence.filter((s) => s !== valid),
    outputs: opened.project.outputs.map((o) =>
      o.include === undefined ? o : { ...o, include: o.include.filter((s) => s !== valid) },
    ),
  })
  rmSync(join(opened.dir, "scenes", valid), { recursive: true, force: true })
  for (const which of Object.keys(FILES) as ScenePart[]) opened.disk.delete(scenePath(valid, which))
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
