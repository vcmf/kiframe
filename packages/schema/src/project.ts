import * as z from "zod"
import { claimIds, CssSelector, idsOf, OrgId, ProjectId, withoutCredentials } from "./common.ts"
import { SceneId } from "./scene.ts"
import { Format, OutputPreset, StyleOverride } from "./style.ts"
import { guarded } from "./guards.ts"
import {
  Action,
  CameraDefault,
  Ensure,
  Locator,
  OFF_CAMERA_MESSAGE,
  notOffCameraOnly,
  presetRefs,
  type Scenario,
  requireSecretStepIds,
} from "./scenario.ts"
import { AppName, Pacing, RuleName, Viewport } from "./settings.ts"
import { sameApp } from "./site.ts"

// Two shapes (docs/OBJECT-MODEL.md §0.5, §0.9, §2; APPROACHES §10c):
// - `Project`: the user's file, `project.json` (org, apps, sequence, outputs, settings);
// - `ProjectConfig`: what the runtime reads, resolved from org settings + the project
//   (`resolveProjectConfig` in resolve.ts): the rule bank from the org.

/** A web app, opened at its address in a fresh browser. */
export const WebApp = z.strictObject({
  kind: z.literal("web"),
  /** http(s) only, and no embedded credentials (use the vault). */
  url: withoutCredentials(z.url({ protocol: /^https?$/ })),
  /** The size its takes are recorded at. */
  viewport: Viewport.prefault({ width: 1440, height: 900 }),
})
export type WebApp = z.infer<typeof WebApp>

/** An https origin (a wrapper app's pages: Slack's, Notion's). */
const HttpsOrigin = z
  .string()
  .max(255)
  .refine((s) => {
    const url = URL.parse(s)
    return url !== null && url.protocol === "https:" && url.origin === s
  }, "an https origin (https://host, no path)")

/**
 * A desktop app's argument as a path in the project's files/ (`files/a/b` → ["a", "b"]); undefined
 * for anything else (files/ itself, an empty, "." or ".." part: never outside it).
 */
export function filesPath(arg: string): string[] | undefined {
  const parts = arg.split("/")
  if (parts[0] !== "files" || parts.length < 2) return undefined
  if (parts.some((p) => p === "" || p === "." || p === "..")) return undefined
  return parts.slice(1)
}

/**
 * A desktop Electron app (OBJECT-MODEL §0.9, design 2026-10-08), named by its bundle id: never a
 * path or a program (a project may come from someone else: the app a bundle id means is found and
 * approved on each machine, by the desktop app). Launched sandboxed for each run.
 */
export const ElectronApp = z.strictObject({
  kind: z.literal("electron"),
  /** The macOS bundle id (`com.example.app`). */
  bundleId: z
    .string()
    .max(255)
    .regex(/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/, "a bundle id (com.example.app)"),
  /**
   * What the app opens: paths in the project's files/ (`files/demo-vault`; a copy is what it gets,
   * decided 2026-10-09), positional only, never a switch.
   */
  args: z
    .array(
      z
        .string()
        .min(1)
        .max(1024)
        // Chromium trims an argument before telling a switch: no space or control character at
        // either end, none inside, never a leading dash.
        .refine(
          (a) =>
            !a.startsWith("-") &&
            !/^\s|\s$/.test(a) &&
            ![...a].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
          "positional arguments only (no switches, no spaces at the ends)",
        )
        .refine(
          (a) => filesPath(a) !== undefined,
          "a path in the project's files/ (files/<name>): a desktop app opens only those",
        ),
    )
    .max(20)
    .optional(),
  /** The sites a wrapper app shows as its own (Slack's app.slack.com): its pages, never another's. */
  origins: z.array(HttpsOrigin).max(10).optional(),
  /** The size its takes are recorded at (emulated: the window itself is never moved). */
  viewport: Viewport.prefault({ width: 1440, height: 900 }),
})
export type ElectronApp = z.infer<typeof ElectronApp>

/** An app a demo shows: a web app, or a desktop Electron app. */
export const App = z.discriminatedUnion("kind", [WebApp, ElectronApp])
export type App = z.infer<typeof App>

/** The web apps of a project (the ones with an address), by name. */
export function webAppsOf(apps: Readonly<Record<string, App>>): Record<string, WebApp> {
  return Object.fromEntries(
    Object.entries(apps).filter((e): e is [string, WebApp] => e[1].kind === "web"),
  )
}

/** A web app's address (a harness that drives web apps only); a desktop app has none: said. */
export function urlOf(app: App): string {
  if (app.kind !== "web") throw new Error(`a desktop app (${app.bundleId}) has no address`)
  return app.url
}

/** What an app is, as one string (a take's key, a label): its address, or `electron:<bundle id>`. */
export function appIdentity(app: App): string {
  return app.kind === "web" ? app.url : `electron:${app.bundleId}`
}

/** The apps of a project, in order (the first is where a scene starts), never two on one site. */
export const Apps = z.record(AppName, App).superRefine((apps, ctx) => {
  const entries = Object.entries(apps)
  if (entries.length === 0) ctx.addIssue({ code: "custom", message: "a project has an app" })
  // Over the cap: said once, never the pairwise check (a hostile file with thousands).
  if (entries.length > 20) {
    ctx.addIssue({ code: "custom", message: "at most 20 apps" })
    return
  }
  // One app per site: two web apps on one site, a wrapper app's site (`origins`) that's a web app's
  // or another wrapper's; one entry per desktop app (its bundle id, in any case).
  const sites = (app: App): string[] => (app.kind === "web" ? [app.url] : (app.origins ?? []))
  const overlap = (a: App, b: App) =>
    sites(a).some((x) => sites(b).some((y) => sameApp(x, y) || sameApp(y, x)))
  entries.forEach(([name, app], i) => {
    for (const [otherName, other] of entries.slice(0, i)) {
      if (
        app.kind === "electron" &&
        other.kind === "electron" &&
        app.bundleId.toLowerCase() === other.bundleId.toLowerCase()
      ) {
        ctx.addIssue({
          code: "custom",
          message: `apps "${otherName}" and "${name}" are the same desktop app: one app each`,
          path: [name, "bundleId"],
        })
        return
      }
      if (overlap(app, other)) {
        ctx.addIssue({
          code: "custom",
          message: `apps "${otherName}" and "${name}" are on the same site: one app per site`,
          path: [name, app.kind === "web" ? "url" : "origins"],
        })
        return
      }
    }
  })
})
export type Apps = z.infer<typeof Apps>

/** The app a scene starts in (the first listed). */
export function firstApp(project: { apps: Apps }): { name: string; app: App } {
  const [name, app] = Object.entries(project.apps)[0] ?? []
  if (name === undefined || app === undefined) throw new Error("a project has an app")
  return { name, app }
}

/** The app a scene starts in: the one it names, else the first (one it names but isn't listed: refused). */
export function startAppOf(
  scenario: { app?: string | undefined },
  project: { apps: Apps },
): { name: string; app: App } {
  if (scenario.app === undefined) return firstApp(project)
  const app = appOf(project, scenario.app)
  if (app === undefined) throw new Error(`app "${scenario.app}" isn't one of the project's apps`)
  return { name: scenario.app, app }
}

/** An app by its name (undefined: not listed; never a key every object has). */
export function appOf(project: { apps: Apps }, name: string): App | undefined {
  return Object.hasOwn(project.apps, name) ? project.apps[name] : undefined
}

/** A shared off-camera setup. Presets are flat: they can't reference other presets (no recursion). */
export const Preset = z.strictObject({
  /** The app its steps start in, by name (default: the project's first; never a desktop app yet). */
  app: AppName.optional(),
  /** Run once per recording batch, then reuse its browser session (login presets). */
  session: z.boolean().default(false),
  steps: z
    .array(z.union([Ensure, Action]))
    .min(1)
    // A preset step typing a secret needs an id: its approval refers to it (SECRETS-DESIGN §3).
    .superRefine((steps, ctx) => requireSecretStepIds(steps, [], ctx)),
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
  }).refine(notOffCameraOnly, { message: OFF_CAMERA_MESSAGE }),
})
export type InterruptRule = z.infer<typeof InterruptRule>

/** Ids are unique inside each preset and across interrupt rules (messages say where). */
function checkIds(
  p: { presets: Record<string, Preset>; interrupts: InterruptRule[] },
  ctx: z.RefinementCtx,
): void {
  for (const [name, preset] of Object.entries(p.presets)) {
    claimIds(preset.steps, ["presets", name, "steps"], ctx)
  }
  claimIds(p.interrupts, ["interrupts"], ctx)
}

/** Unguarded: internal only, use the guarded export. */
const ProjectConfigBase = z
  .strictObject({
    version: z.literal(2),
    apps: Apps,
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
  .superRefine(checkIds)

/** Project config, with whole-document guards (forbidden keys, secret references). */
export const ProjectConfig = guarded(ProjectConfigBase, [
  ["presets", "*", "steps", "#", "value"],
  ["interrupts", "#", "do", "value"],
])
export type ProjectConfig = z.infer<typeof ProjectConfigBase>

/**
 * The apps a scene would use that the project doesn't list: the scene's start app, its gotos and
 * URL conditions, those of the presets it uses. (Not the interrupt rules': an org's apply to every
 * project; a rule's goto to an app a project doesn't list fails where it runs.)
 * Human-readable, one per name (empty = OK).
 */
export function unknownApps(scenario: Scenario, project: ProjectConfig): string[] {
  return unlistedApps(scenario, project).map(
    (name) => `uses app "${name}", which the project doesn't list`,
  )
}

/** The apps a scene names that the project doesn't list (one removed, a typo): their names. */
export function unlistedApps(
  scenario: Scenario,
  project: Pick<ProjectConfig, "presets" | "apps">,
): string[] {
  return [...appsNamedBy(scenario, project)].filter((name) => appOf(project, name) === undefined)
}

/** The apps a step names: a goto's, a URL condition's (a scroll's `until` is a target: no URL). */
function appsOfItem(item: object, add: (name: unknown) => void): void {
  const i = item as { action?: unknown; app?: unknown; until?: unknown; that?: unknown }
  if (i.action === "goto") add(i.app)
  for (const condition of [i.until, i.that]) {
    if (typeof condition === "object" && condition !== null && "url" in condition) {
      add((condition as { app?: unknown }).app)
    }
  }
}

/** Every app a preset names: its own, and its steps' gotos and URL conditions. */
export function appsNamedByPreset(preset: Preset): Set<string> {
  const named = new Set<string>()
  const add = (name: unknown) => {
    if (typeof name === "string") named.add(name)
  }
  add(preset.app)
  for (const step of preset.steps) appsOfItem(step, add)
  return named
}

/**
 * Every app a scene names (listed or not): its start app, its gotos' and URL conditions', those of
 * the presets it uses. (Not an older scene's teardown: it never runs.)
 */
export function appsNamedBy(
  scenario: Scenario,
  project: Pick<ProjectConfig, "presets">,
): Set<string> {
  const named = new Set<string>()
  const add = (name: unknown) => {
    if (typeof name === "string") named.add(name)
  }
  add(scenario.app)
  for (const item of [...(scenario.setup ?? []), ...scenario.steps]) appsOfItem(item, add)
  for (const name of presetRefs(scenario)) {
    const preset = Object.hasOwn(project.presets, name) ? project.presets[name] : undefined
    if (preset !== undefined) for (const app of appsNamedByPreset(preset)) named.add(app)
  }
  return named
}

/** Cross-file checks a single schema can't do. Returns human-readable problems (empty = OK). */
export function checkScenarioAgainstProject(scenario: Scenario, project: ProjectConfig): string[] {
  const problems: string[] = [...unknownApps(scenario, project)]
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
    version: z.literal(2),
    id: ProjectId,
    orgId: OrgId,
    name: z.string().min(1).max(200),
    /** Every app the demo shows (no environments: each app has its own URL, §0.9). */
    apps: Apps,
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
    checkIds(p, ctx)
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

/** The files a guide output writes: its `formats`, Markdown by default. */
export function guideFormats(output: Output): ("markdown" | "html" | "pdf")[] {
  return output.formats ?? ["markdown"]
}
