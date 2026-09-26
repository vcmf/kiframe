import * as z from "zod"
import { Action, CameraDirective, Ensure, Locator, presetRefs, type Scenario } from "./scenario.ts"
import { Pacing, Viewport } from "./settings.ts"

// Project-level configuration shared by every scene (docs/OBJECT-MODEL.md §2, §2b).
// Phase 0: the target URL lives here. Org-level environments come with accounts (APPROACHES §10c).

export const TargetApp = z.strictObject({
  kind: z.literal("web"),
  /** http(s) only: the app Kiframe drives. */
  url: z.url({ protocol: /^https?$/ }),
  viewport: Viewport,
})
export type TargetApp = z.infer<typeof TargetApp>

/** A shared off-camera setup. Presets are flat: they can't reference other presets (no recursion). */
export const Preset = z.strictObject({
  /** Run once per recording batch, then reuse its browser session (login presets). */
  session: z.boolean().default(false),
  steps: z.array(z.union([Ensure, Action])).min(1),
})
export type Preset = z.infer<typeof Preset>

/** Off-camera handling of unpredictable popups, checked before each step (§2b). */
export const InterruptRule = z.strictObject({
  id: z.string().min(1).optional(),
  when: z.union([Locator, z.strictObject({ text: z.string().min(1) })]),
  do: Action,
})
export type InterruptRule = z.infer<typeof InterruptRule>

export const ProjectConfig = z.strictObject({
  version: z.literal(1),
  environment: z.string().min(1).optional(),
  target: TargetApp,
  defaults: z
    .strictObject({
      pacing: Pacing.prefault({}),
      camera: CameraDirective.default("auto"),
    })
    .prefault({}),
  presets: z.record(z.string().min(1), Preset).default({}),
  interrupts: z.array(InterruptRule).default([]),
  /** CSS selectors hidden from the frame (display: none). */
  hide: z.array(z.string().min(1)).default([]),
  redaction: z
    .strictObject({
      selectors: z.array(z.string().min(1)).default([]),
      secrets: z.literal("auto").default("auto"),
    })
    .prefault({}),
})
export type ProjectConfig = z.infer<typeof ProjectConfig>

/** Cross-file checks a single schema can't do. Returns human-readable problems (empty = OK). */
export function checkScenarioAgainstProject(scenario: Scenario, project: ProjectConfig): string[] {
  return presetRefs(scenario)
    .filter((name) => !(name in project.presets))
    .map((name) => `setup uses unknown preset "${name}"`)
}
