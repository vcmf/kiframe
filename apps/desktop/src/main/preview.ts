// A scene's preview: its composition, its scenario and the take the composition was made from,
// for the window's player. Only a take of the scene as it is now plays (a scenario changed since
// filming is said so, never played as the new one). Electron-free.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { type OpenedProject, readTakeRecords, type TakeStore } from "@kiframe/project"
import { scenarioHashOf } from "@kiframe/runtime"
import { resolveFormat, resolveStyle, scenesOf } from "@kiframe/schema"
import type { Preview } from "../shared/ipc.ts"

export async function previewOf(
  opened: OpenedProject,
  takes: TakeStore,
  sceneId: string,
): Promise<Preview> {
  const stored = opened.scenes.get(sceneId)
  if (stored === undefined) return { ok: false, why: "This scene isn’t in the project." }
  if (stored.scene.source.kind !== "recording") {
    return { ok: false, why: "A title card: it shows in the exported video." }
  }
  const { scenario, composition } = stored
  // A part that didn't read is said as such (never "not filmed").
  const broken = opened.problems.find((p) => p.sceneId === sceneId && p.part !== undefined)
  if (broken !== undefined) return { ok: false, why: `It didn’t read: ${broken.message}` }
  if (scenario === undefined) return { ok: false, why: "Not grounded yet: no steps to film." }
  if (composition?.take === undefined) {
    return { ok: false, why: "Not filmed yet: the agent records it once its steps work." }
  }
  let take: ReturnType<TakeStore["take"]>
  try {
    take = takes.take(opened.project.id, sceneId, composition.take.key)
  } catch (error) {
    // A take folder that can't be read may be that one: never said to be gone.
    return { ok: false, why: `Its take didn’t read: ${message(error)}` }
  }
  if (take === undefined) {
    return { ok: false, why: "Its take is gone from this computer: record the scene again." }
  }
  // The take films the scenario as it was: a scene changed since plays nothing old as new.
  if (take.meta.scenarioHash !== scenarioHashOf(scenario)) {
    return { ok: false, why: "The scene changed since it was filmed: record it again." }
  }
  // The first video output playing this scene (its size and style); none: the default size.
  const output = opened.project.outputs.find(
    (o) => o.kind === "video" && scenesOf(opened.project, o).includes(sceneId),
  )
  let records: ReturnType<typeof readTakeRecords>
  let video: Uint8Array
  try {
    records = readTakeRecords(take.dir)
    // Read without holding main's thread (a take is tens of MB).
    video = await readFile(join(take.dir, "frames.webm"))
  } catch (error) {
    return { ok: false, why: `Its take didn’t read: ${message(error)}` }
  }
  return {
    ok: true,
    sceneId,
    title: stored.scene.title,
    composition,
    scenario,
    take: records,
    video,
    // As the export resolves it: project (no org settings in the app yet), scene, the output.
    style: resolveStyle(undefined, opened.project, composition.style, output),
    // No output plays it (a draft, or none yet): the size an output is by default.
    format: sizeOf(output ?? { id: "preview", kind: "video" }),
  }
}

/** An output's size, its fps said (resolveFormat's type leaves it optional; its value never is). */
function sizeOf(output: Parameters<typeof resolveFormat>[0]): {
  width: number
  height: number
  fps: number
} {
  const f = resolveFormat(output)
  return { width: f.width, height: f.height, fps: f.fps ?? 30 }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
