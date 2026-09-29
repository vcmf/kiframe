import {
  Composition,
  isCertainlyNotAfter,
  type Anchor,
  type CameraDirective,
  type ProjectConfig,
  type Scenario,
} from "@kiframe/schema"
import { effectiveCamera, generateCamera, type CameraOptions } from "./camera.ts"
import { generateClips, type ClipOptions } from "./clips.ts"
import { generateCaptions, generateCursor } from "./overlays.ts"
import { buildTimeline, timeMap, type TakeInput } from "./timeline.ts"

// generate(scenario, take) → auto segments (docs/OBJECT-MODEL.md §4.1). Pure: no LLM, no I/O.

export interface GenerateOptions {
  camera?: CameraOptions
  clips?: ClipOptions
}

export interface Generated {
  /** A composition holding only `auto` segments, for this take. */
  composition: Composition
  /** What couldn't be generated as asked (a directive that fell back, a step missing from the take). */
  warnings: string[]
}

export function generate(
  project: ProjectConfig,
  scenario: Scenario,
  take: TakeInput,
  options: GenerateOptions = {},
): Generated {
  const { timeline: tl, missing } = buildTimeline(scenario, take)
  const warnings = missing.map((id) => `step ${id} isn't in the take: re-record to place it`)
  const directives = new Map<string, CameraDirective>(
    tl.steps.map((s) => [
      s.id,
      effectiveCamera(s, scenario.overrides?.camera, project.defaults.camera),
    ]),
  )
  const clips = generateClips(tl, options.clips)
  // Camera timing is judged in output time: after the clips' cuts and speed-ups.
  const { toOutput } = timeMap(clips.clips, tl)
  const camera = generateCamera(tl, directives, options.camera, toOutput)
  warnings.push(...clips.warnings, ...camera.warnings)

  // A span that ended up empty after rounding (sub-millisecond) is dropped, never emitted inverted.
  const nonEmpty = <T extends { id: string; at: Anchor; until?: Anchor }>(segments: T[]) =>
    segments.filter((s) => s.until === undefined || !isCertainlyNotAfter(s.until, s.at))

  const composition = Composition.parse({
    version: 1,
    take: { key: take.meta.takeKey },
    tracks: {
      clips: nonEmpty(clips.clips),
      camera: nonEmpty(camera.camera),
      cursor: nonEmpty(generateCursor(tl)),
      captions: nonEmpty(generateCaptions(tl)),
      // Secret regions are drawn from the take at render time (SECRETS-DESIGN I4), never masks here.
      masks: [],
      callouts: [],
      keystrokes: [],
    },
  })
  return { composition, warnings }
}
