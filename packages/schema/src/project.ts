import * as z from "zod"
import { claimIds, CssSelector, idsOf, OrgId, withoutCredentials } from "./common.ts"
import { SceneId } from "./scene.ts"
import { Format, OutputPreset, StyleOverride } from "./style.ts"
import { guarded } from "./guards.ts"
import { Action, CameraDefault, Ensure, Locator, presetRefs, type Scenario } from "./scenario.ts"
import { Pacing, RuleName, Viewport } from "./settings.ts"

// Two shapes (docs/OBJECT-MODEL.md §0.5, §2; APPROACHES §10c):
// - `Project`: the user's file, `project.json` (org, environment, sequence, outputs, settings);
// - `ProjectConfig`: what the runtime reads, resolved from org settings + the project
//   (`resolveProjectConfig` in resolve.ts): the target URL comes from the environment, the rule
//   bank from the org.

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

// ─── The project file ─────────────────────────────────────────────────────────

/** A deliverable made from the sequence: a video or a guide (v0 kinds). */
export const Output = z
  .strictObject({
    id: RuleName,
    kind: z.enum(["video", "guide"]),
    /** Video only: 16:9, 9:16 or 1:1 (also tightens the camera and enlarges captions later). */
    preset: OutputPreset.optional(),
    /** Default: every scene of the sequence. Always played in sequence order. */
    include: z.array(SceneId).optional(),
    /** Video only: an explicit size (overrides the preset). */
    format: Format.optional(),
    /** Video only: overrides of the org / project style. */
    style: StyleOverride.optional(),
    /** Guide only: the files to write. */
    formats: z
      .array(z.enum(["markdown", "html", "pdf"]))
      .min(1)
      .optional(),
  })
  .superRefine((o, ctx) => {
    const videoOnly = ["preset", "format", "style"] as const
    if (o.kind === "guide") {
      for (const key of videoOnly) {
        if (o[key] !== undefined) {
          ctx.addIssue({ code: "custom", message: `\`${key}\` is for videos`, path: [key] })
        }
      }
    } else if (o.formats !== undefined) {
      ctx.addIssue({ code: "custom", message: "`formats` is for guides", path: ["formats"] })
    }
  })
export type Output = z.infer<typeof Output>

/** Unguarded: internal only, use the guarded export. */
const ProjectBase = z
  .strictObject({
    version: z.literal(1),
    id: OrgId,
    orgId: OrgId,
    name: z.string().min(1).max(200),
    /** An environment of the org (its URL and safety flags). */
    environment: RuleName.optional(),
    target: z.strictObject({
      kind: z.literal("web"),
      /** Only without an environment (a local app, no org settings). */
      url: withoutCredentials(z.url({ protocol: /^https?$/ })).optional(),
      viewport: Viewport,
    }),
    defaults: ProjectConfigBase.shape.defaults,
    presets: ProjectConfigBase.shape.presets,
    interrupts: ProjectConfigBase.shape.interrupts,
    hide: ProjectConfigBase.shape.hide,
    redaction: ProjectConfigBase.shape.redaction,
    /** The story order: the only ordering of scenes. */
    sequence: z.array(SceneId).default([]),
    outputs: z.array(Output).default([]),
    style: StyleOverride.optional(),
  })
  .superRefine((p, ctx) => {
    if (p.environment === undefined && p.target.url === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "a project needs an environment, or a target url",
        path: ["target", "url"],
      })
    }
    for (const [name, preset] of Object.entries(p.presets)) {
      claimIds(preset.steps, ["presets", name, "steps"], ctx)
    }
    claimIds(p.interrupts, ["interrupts"], ctx)
    const inSequence = new Set<string>()
    p.sequence.forEach((id, i) => {
      if (inSequence.has(id)) {
        ctx.addIssue({
          code: "custom",
          message: `scene "${id}" is twice in the sequence`,
          path: ["sequence", i],
        })
      }
      inSequence.add(id)
    })
    const outputIds = new Set<string>()
    p.outputs.forEach((o, i) => {
      if (outputIds.has(o.id)) {
        ctx.addIssue({
          code: "custom",
          message: `output "${o.id}" is declared twice`,
          path: ["outputs", i, "id"],
        })
      }
      outputIds.add(o.id)
      const included = new Set<string>()
      o.include?.forEach((id, j) => {
        if (!inSequence.has(id)) {
          ctx.addIssue({
            code: "custom",
            message: `output "${o.id}" includes "${id}", which isn't in the sequence`,
            path: ["outputs", i, "include", j],
          })
        } else if (included.has(id)) {
          ctx.addIssue({
            code: "custom",
            message: `output "${o.id}" includes "${id}" twice`,
            path: ["outputs", i, "include", j],
          })
        }
        included.add(id)
      })
    })
  })

/** The project file, with whole-document guards (same secret slots as the resolved config). */
export const Project = guarded(ProjectBase, [
  ["presets", "*", "steps", "#", "value"],
  ["interrupts", "#", "do", "value"],
])
export type Project = z.infer<typeof ProjectBase>
