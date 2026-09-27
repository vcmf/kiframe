import type { Environment, OrgSettings } from "./org.ts"
import { ProjectConfig, type Output, type Project } from "./project.ts"
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
 * The runtime config of a project: the target URL from its environment (the environment wins over
 * the project's own URL), and the org's rule bank before the project's rules (a project rule with
 * the same id replaces the org's). A named environment the org doesn't declare is an error, never a
 * silent fallback: the project could then drive the wrong app.
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
  const url = env?.url ?? project.target.url
  if (url === undefined) throw new ResolveError("the project has no environment and no target url")
  const own = new Set(project.interrupts.map((r) => r.id))
  const interrupts = [
    ...(org?.rules.interrupts ?? []).filter((r) => !own.has(r.id)),
    ...project.interrupts,
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

/** The environment's required secrets the user hasn't filled in yet (names only). */
export function missingSecrets(
  environment: ResolvedEnvironment,
  provided: Iterable<string>,
): string[] {
  const have = new Set(provided)
  return environment.requiredSecrets.filter((name) => !have.has(name))
}
