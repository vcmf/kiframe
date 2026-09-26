import * as z from "zod"
import { claimIds, CssSelector, idsOf, withoutCredentials } from "./common.ts"
import { guarded } from "./guards.ts"
import { Action, CameraDefault, Ensure, Locator, presetRefs, type Scenario } from "./scenario.ts"
import { Pacing, RuleName, Viewport } from "./settings.ts"

// Project-level configuration shared by every scene (docs/OBJECT-MODEL.md §2, §2b).
// Phase 0: the target URL lives here. Org-level environments come with accounts (APPROACHES §10c).

export const TargetApp = z.strictObject({
  kind: z.literal("web"),
  /** http(s) only, and no embedded credentials (use the vault): the app Kiframe drives. */
  url: withoutCredentials(z.url({ protocol: /^https?$/ })),
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
  /** Required: interrupt take events refer to the rule by this id. */
  id: RuleName,
  when: z.union([Locator, z.strictObject({ text: z.string().min(1) })]),
  /** No `id` on the action: interrupt events are identified by the rule id, not a step id. */
  do: Action.refine((action) => !("id" in action) || action.id === undefined, {
    message: "interrupt actions can't have an id (the rule id identifies them)",
  }),
})
export type InterruptRule = z.infer<typeof InterruptRule>

/** Unguarded: internal only, use the guarded export. */
const ProjectConfigBase = z
  .strictObject({
    version: z.literal(1),
    environment: RuleName.optional(),
    target: TargetApp,
    defaults: z
      .strictObject({
        pacing: Pacing.prefault({}),
        camera: CameraDefault.default("auto"),
      })
      .prefault({}),
    presets: z.record(RuleName, Preset).default({}),
    interrupts: z.array(InterruptRule).default([]),
    /** CSS selectors hidden from the frame (display: none). */
    hide: z.array(CssSelector).default([]),
    redaction: z
      .strictObject({
        selectors: z.array(CssSelector).default([]),
        secrets: z.literal("auto").default("auto"),
      })
      .prefault({}),
  })
  .superRefine((p, ctx) => {
    // Ids are unique inside each preset and across interrupt rules (messages say where).
    for (const [name, preset] of Object.entries(p.presets)) {
      claimIds(preset.steps, ["presets", name, "steps"], ctx)
    }
    claimIds(p.interrupts, ["interrupts"], ctx)
  })

/** Project config, with whole-document guards (forbidden keys, secret references). */
export const ProjectConfig = guarded(ProjectConfigBase, [
  ["presets", "*", "steps", "#", "value"],
  ["interrupts", "#", "do", "value"],
])
export type ProjectConfig = z.infer<typeof ProjectConfigBase>

/** Cross-file checks a single schema can't do. Returns human-readable problems (empty = OK). */
export function checkScenarioAgainstProject(scenario: Scenario, project: ProjectConfig): string[] {
  const problems: string[] = []
  const scenarioIds = new Set(
    idsOf([...(scenario.setup ?? []), ...scenario.steps, ...(scenario.teardown ?? [])]),
  )
  // Ids of every used preset must be unique among themselves and against the scenario. A preset
  // used twice would repeat its ids, so that's reported too (unless its steps have no ids).
  const presetIdOwner = new Map<string, string>()
  const used = new Set<string>()
  for (const name of presetRefs(scenario)) {
    if (!Object.hasOwn(project.presets, name)) {
      problems.push(`setup uses unknown preset "${name}"`)
      continue
    }
    const stepIds = idsOf(project.presets[name]?.steps ?? [])
    if (used.has(name)) {
      if (stepIds.length > 0) problems.push(`preset "${name}" is used twice and has step ids`)
      continue
    }
    used.add(name)
    for (const id of stepIds) {
      if (scenarioIds.has(id)) {
        problems.push(`preset "${name}" step id "${id}" collides with an id in the scenario`)
      }
      const owner = presetIdOwner.get(id)
      if (owner !== undefined) {
        problems.push(`preset "${name}" step id "${id}" collides with preset "${owner}"`)
      } else {
        presetIdOwner.set(id, name)
      }
    }
  }
  return problems
}
