// The open project: one at a time, opened or created from a folder main chose (never a path the
// window sent), and shown to the window as a `ProjectView`.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import { type OpenedProject, saveProject, scenesNaming } from "@kiframe/project"
import { type App, appOf, appsNamedByPreset, firstApp, unlistedApps, WebApp } from "@kiframe/schema"
import { type AppView, appViewIdentity, type ProjectView, type SceneView } from "../shared/ipc.ts"

/** A project folder's extension (a new project's folder gets it). */
export const PROJECT_EXTENSION = ".kiframe"

/** An app as the window has it: a web app by its exact origin, a desktop app by its bundle id. */
export function appView(name: string, app: App): AppView {
  return app.kind === "web"
    ? { name, kind: "web", origin: new URL(app.url).origin }
    : { name, kind: "electron", bundleId: app.bundleId }
}

/** The app's address, by the project schema's own rule (http(s), no credentials in it). */
export function targetUrl(url: string): string {
  const parsed = WebApp.shape.url.safeParse(url.trim())
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

/**
 * The project as the window shows it: the scenes in story order, then any outside the sequence.
 * Nothing wrong is hidden: a scene with a part that didn't read, or whose folder is missing, says
 * so, and every problem is listed.
 */
export function projectView(opened: OpenedProject, session: string): ProjectView {
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
    // Apps it names that the project doesn't list (one removed): said, its status kept.
    const removedApps = stored.scenario === undefined ? [] : unlistedApps(stored.scenario, project)
    const status =
      stored.composition !== undefined
        ? "recorded"
        : stored.scenario !== undefined
          ? "grounded"
          : "empty"
    const take = stored.composition?.take?.key
    const version =
      stored.composition === undefined
        ? undefined
        : createHash("sha256")
            // Everything its preview shows: the scene, and the project's style and outputs.
            .update(
              JSON.stringify([stored.scenario, stored.composition, project.style, project.outputs]),
            )
            .digest("hex")
            .slice(0, 16)
    views.push({
      id,
      title: scene.title,
      status,
      ...(take !== undefined && { take }),
      ...(version !== undefined && { version }),
      ...(removedApps.length > 0 && { removedApps }),
    })
  }
  return {
    session,
    name: project.name,
    dir: opened.dir,
    apps: Object.entries(project.apps).map(([name, app]) => appView(name, app)),
    scenes: views,
    problems: problems.map((p) => `${p.sceneId}: ${p.message}`),
  }
}

/**
 * The exact origin of one of the open project's apps, for the window's request made in its opening
 * `session` (the window names an app, never an origin; a request from before another project
 * opened is refused): why not, in words, otherwise.
 */
export function appOriginOf(
  view: Pick<ProjectView, "session" | "apps"> | undefined,
  session: string,
  app: string,
): AppView | { why: string } {
  if (view === undefined) return { why: "open a project first" }
  if (view.session !== session) return { why: "the project changed meanwhile: try again" }
  const found = view.apps.find((a) => a.name === app)
  return found === undefined ? { why: `"${app}" isn't one of the project's apps` } : found
}

/**
 * The origin a secret of `app` is kept for: a web app's; a desktop app takes none in v0 (the user
 * signs in by hand there), said.
 */
export function secretOriginOf(
  view: Pick<ProjectView, "session" | "apps"> | undefined,
  session: string,
  app: string,
): { origin: string } | { why: string } {
  const at = appOriginOf(view, session, app)
  if ("why" in at) return at
  if (at.kind !== "web") {
    return { why: `"${app}" is a desktop app: it takes no secrets (sign in by hand when Kif asks)` }
  }
  return { origin: at.origin }
}

/** The titles of the scenes that name `app` (`scenesNaming`: every stored scene). */
export const scenesUsing = scenesNaming

/**
 * Takes an app off the open project (never its first: where scenes start, refused). Saved over the
 * project as it is now (a changed project.json on disk: refused by the store).
 */
export function removeApp(opened: OpenedProject, app: string): void {
  if (firstApp(opened.project).name === app) {
    throw new Error(`"${app}" is where scenes start: it can't be removed`)
  }
  if (appOf(opened.project, app) === undefined) {
    throw new Error(`"${app}" isn't one of the project's apps`)
  }
  const apps = Object.fromEntries(
    Object.entries(opened.project.apps).filter(([name]) => name !== app),
  )
  saveProject(opened, { ...opened.project, apps })
}

/**
 * Why the window's request to remove an app is refused (null: it may go on): the agent working (an
 * add_app card may be open), an earlier opening of the project, an app by that name that isn't the
 * one the window showed (`origin`), or the first app (where scenes start).
 */
export function appRemovalRefused(
  view: Pick<ProjectView, "session" | "apps"> | undefined,
  request: { session: string; name: string; identity: string },
  running: boolean,
): string | null {
  if (running) return "Kif is working: stop it first"
  const at = appOriginOf(view, request.session, request.name)
  if ("why" in at) return at.why
  if (appViewIdentity(at) !== request.identity) return "that app changed meanwhile: try again"
  if (view?.apps[0]?.name === request.name) {
    return `"${request.name}" is where scenes start: it can't be removed`
  }
  return null
}

/** The presets that name `app` (theirs, or a goto or URL condition in their steps). */
export function presetsUsing(opened: OpenedProject, app: string): string[] {
  return Object.entries(opened.project.presets)
    .filter(([, preset]) => appsNamedByPreset(preset).has(app))
    .map(([name]) => name)
}

/** The project's interrupt rules whose goto names `app`. */
export function interruptsUsing(opened: OpenedProject, app: string): string[] {
  return opened.project.interrupts
    .filter((rule) => rule.do.action === "goto" && rule.do.app === app)
    .map((rule) => rule.id)
}
