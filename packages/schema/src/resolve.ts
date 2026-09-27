import type { Environment, OrgSettings } from "./org.ts"
import { ProjectConfig, type Output, type Project } from "./project.ts"
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
  /** Undefined for a project with its own URL and no environment. */
  name?: string
  url: string
  sandbox: boolean
  preApproveTeardown: boolean
  requiredSecrets: string[]
}

export class ResolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ResolveError"
  }
}

/**
 * The runtime config of a project: the target URL from its environment, or its own URL (a project
 * has exactly one of them), and the org's rule bank before the project's rules (a project rule with
 * the same id replaces the org's, in its place). A named environment the org doesn't declare is an
 * error, never a silent fallback: the project could then drive the wrong app.
 */
export function resolveProjectConfig(
  project: Project,
  org: OrgSettings | undefined,
): { config: ProjectConfig; environment: ResolvedEnvironment } {
  let env: Environment | undefined
  if (project.environment !== undefined) {
    env = org?.environments.find((e) => e.name === project.environment)
    if (env === undefined) {
      throw new ResolveError(
        `environment "${project.environment}" isn't declared in the org settings`,
      )
    }
  }
  const url = env !== undefined ? env.url : project.target.url
  // The schema guarantees one of them; kept as a guard for configs built without it.
  if (url === undefined) throw new ResolveError("the project has no environment and no target url")
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
    version: 1,
    ...(env !== undefined && { environment: env.name }),
    target: { kind: "web", url, viewport: project.target.viewport },
    defaults: project.defaults,
    presets: project.presets,
    interrupts,
    hide,
    redaction: project.redaction,
  })
  return {
    config,
    environment: {
      ...(env !== undefined && { name: env.name }),
      url,
      sandbox: env?.sandbox ?? false,
      preApproveTeardown: env?.preApproveTeardown ?? false,
      requiredSecrets: env?.requiredSecrets ?? [],
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
  for (const s of scenarios) [...(s.setup ?? []), ...s.steps, ...(s.teardown ?? [])].forEach(typed)
  return [...names]
}

/** The required secrets (see `requiredSecrets`) the user hasn't filled in yet: names only. */
export function missingSecrets(required: readonly string[], provided: Iterable<string>): string[] {
  const have = new Set(provided)
  return required.filter((name) => !have.has(name))
}
