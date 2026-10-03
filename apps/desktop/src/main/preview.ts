// A scene's preview: its composition, its scenario and the take the composition was made from,
// for the window's player. Only a take of the scene as it is now plays (a scenario changed since
// filming is said so, never played as the new one). Electron-free.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { type OpenedProject, readTakeRecords, type TakeStore } from "@kiframe/project"
import { scenarioHashOf } from "@kiframe/runtime"
import { resolveFormat, resolveStyle } from "@kiframe/schema"
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
  if (scenario === undefined) return { ok: false, why: "Not grounded yet: no steps to film." }
  if (composition?.take === undefined) {
    return { ok: false, why: "Not filmed yet: the agent records it once its steps work." }
  }
  const take = takes.take(opened.project.id, sceneId, composition.take.key)
  if (take === undefined) {
    return { ok: false, why: "Its take is gone from this computer: record the scene again." }
  }
  // The take films the scenario as it was: a scene changed since plays nothing old as new.
  if (take.meta.scenarioHash !== scenarioHashOf(scenario)) {
    return { ok: false, why: "The scene changed since it was filmed: record it again." }
  }
  // The first video output playing this scene (its size and style); none: the default size.
  const output = opened.project.outputs.find(
    (o) => o.kind === "video" && (o.include === undefined || o.include.includes(sceneId)),
  )
  let records: ReturnType<typeof readTakeRecords>
  let video: Uint8Array
  try {
    records = readTakeRecords(take.dir)
    // Read without holding main's thread (a take is tens of MB).
    video = await readFile(join(take.dir, "frames.webm"))
  } catch {
    return { ok: false, why: "Its take didn’t read: record the scene again." }
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
    format: output !== undefined ? formatOf(output) : DEFAULT_FORMAT,
  }
}

/** The size a scene previews at when no output plays it (the export's default). */
const DEFAULT_FORMAT = { width: 1920, height: 1080, fps: 30 }

/** An output's size, every field said. */
function formatOf(output: Parameters<typeof resolveFormat>[0]): {
  width: number
  height: number
  fps: number
} {
  const f = resolveFormat(output)
  return { width: f.width, height: f.height, fps: f.fps ?? DEFAULT_FORMAT.fps }
}
