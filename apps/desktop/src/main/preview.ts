// A scene's preview: its composition, its scenario and the take the composition was made from,
// for the window's player. Only a take of the scene as it is now plays (a scenario changed since
// filming is said so, never played as the new one). Electron-free.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type OpenedProject, readTakeRecords, type TakeStore } from "@kiframe/project"
import { scenarioHashOf } from "@kiframe/runtime"
import { applyStyle, DEFAULT_STYLE } from "@kiframe/schema"
import type { Preview } from "../shared/ipc.ts"

export function previewOf(opened: OpenedProject, takes: TakeStore, sceneId: string): Preview {
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
  let records: ReturnType<typeof readTakeRecords>
  let video: Uint8Array
  try {
    records = readTakeRecords(take.dir)
    video = readFileSync(join(take.dir, "frames.webm"))
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
    // The project's look under the scene's (no org settings in the app yet).
    baseStyle: applyStyle(DEFAULT_STYLE, opened.project.style),
  }
}
