import type { OrgSettings } from "./org.ts"
import { firstApp, ProjectConfig, type Output, type Project } from "./project.ts"
import { secretRefName } from "./common.ts"
import type { Scenario } from "./scenario.ts"
import type { SceneId } from "./scene.ts"
import {
  applyStyle,
  DEFAULT_STYLE,
  OUTPUT_PRESETS,
  type Format,
  type Style,
  type StyleOverride,
} from "./style.ts"

// Layered settings (APPROACHES §10c): product defaults → org → project → scene → step. Scene and
// step overrides live in the scenario and are applied by the runtime; this resolves the rest.

/** The environment a project runs against, after resolution. */
export interface ResolvedEnvironment {
  url: string
  requiredSecrets: string[]
}

/**
 * The runtime config of a project: its apps, and the org's rule bank before the project's rules (a
 * project rule with the same id replaces the org's, in its place). A project has no environment
 * since v2 (each app has its own URL, OBJECT-MODEL §0.9), and nothing risky is ever pre-approved
 * (every risky step asks the user).
 */
export function resolveProjectConfig(
  project: Project,
  org: OrgSettings | undefined,
): {
  config: ProjectConfig
  environment: ResolvedEnvironment
  /**
   * The ids of the org's interrupt rules the config kept as they are (a project rule with the same
   * id replaces one): their secret approvals are the org's (SECRETS-DESIGN §3 A1).
   */
  orgInterrupts: string[]
} {
  const own = new Map(project.interrupts.map((r) => [r.id, r]))
  const orgRules = org?.rules.interrupts ?? []
  const orgIds = new Set(orgRules.map((r) => r.id))
  const interrupts = [
    // Rules are tried in order: an overridden org rule keeps its place.
    ...orgRules.map((r) => own.get(r.id) ?? r),
    ...project.interrupts.filter((r) => !orgIds.has(r.id)),
  ]
  const hide = [...new Set([...(org?.rules.hide ?? []), ...project.hide])]
  const config = ProjectConfig.parse({
    version: 2,
    apps: project.apps,
    defaults: project.defaults,
    presets: project.presets,
    interrupts,
    hide,
    redaction: project.redaction,
  })
  return {
    config,
    orgInterrupts: orgRules.filter((r) => !own.has(r.id)).map((r) => r.id),
    environment: {
      url: firstApp(config).app.url,
      requiredSecrets: [],
    },
  }
}

/**
 * The style of a scene in an output: product defaults, then the org, the project, the scene (its
 * composition's `style`) and the output, each overriding the one before, field by field.
 */
export function resolveStyle(
  org: OrgSettings | undefined,
  project: Project,
  scene?: StyleOverride,
  output?: Output,
): Style {
  return applyStyle(DEFAULT_STYLE, org?.style, project.style, scene, output?.style)
}

/** The size of a video output: its explicit format, else its preset (landscape by default). */
export function resolveFormat(output: Output): Required<Format> {
  const size = output.format ?? OUTPUT_PRESETS[output.preset ?? "landscape"]
  return { width: size.width, height: size.height, fps: output.format?.fps ?? 30 }
}

/** The scenes an output plays: its `include` (or every scene), always in sequence order. */
export function scenesOf(project: Project, output: Output): SceneId[] {
  if (output.include === undefined) return [...project.sequence]
  const included = new Set(output.include)
  return project.sequence.filter((id) => included.has(id))
}

/**
 * Every secret a project needs: the environment's declared ones, plus every `{{secrets.x}}` its
 * presets, interrupt rules (org and project) and the given scenes' scenarios actually type.
 */
export function requiredSecrets(
  config: ProjectConfig,
  environment: ResolvedEnvironment,
  scenarios: readonly Scenario[] = [],
): string[] {
  const names = new Set(environment.requiredSecrets)
  const typed = (item: object) => {
    const value = (item as { action?: unknown; value?: unknown }).value
    if ((item as { action?: unknown }).action !== "type" || typeof value !== "string") return
    const name = secretRefName(value)
    if (name !== undefined) names.add(name)
  }
  for (const preset of Object.values(config.presets)) preset.steps.forEach(typed)
  for (const rule of config.interrupts) typed(rule.do)
  // (Not an older scene's teardown: it never runs, so it never types.)
  for (const s of scenarios) [...(s.setup ?? []), ...s.steps].forEach(typed)
  return [...names]
}

/** The required secrets (see `requiredSecrets`) the user hasn't filled in yet: names only. */
export function missingSecrets(required: readonly string[], provided: Iterable<string>): string[] {
  const have = new Set(provided)
  return required.filter((name) => !have.has(name))
}
