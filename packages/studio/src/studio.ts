import { generate } from "@kiframe/generators"
import { type OpenedProject, saveScene, type TakeStore } from "@kiframe/project"
import {
  locatorFor,
  recordScenario,
  runScenario,
  scrubSecrets,
  type SecretUse,
  StepError,
  type StepRef,
  visibleOnly,
} from "@kiframe/runtime"
import {
  Action,
  checkScenarioAgainstProject,
  Ensure,
  Locator,
  parseScenarioYaml,
  PresetRef,
  type ProjectConfig,
  type Scenario,
  SetupItem,
  Step,
} from "@kiframe/schema"
import type { Browser, BrowserContext, Page } from "playwright"
import { parse as parseYaml } from "yaml"

// The studio: what the agent's tools act on (the project, the live app, the take store), for one
// open project. The host (the desktop app's main process) makes one per project and passes it to
// the agent as the tools' context. Ported from the P0-8 grounding script.

/** What the agent may ask the user, and what comes back. A request rejects at the stop. */
export type UserRequest =
  | { kind: "question"; question: string }
  | { kind: "approve-risky"; scene: string; step: string; action: string }

export interface StudioOptions {
  project: OpenedProject
  /** The project resolved for the runtime (org settings + project: `resolveProjectConfig`). */
  config: ProjectConfig
  takes: TakeStore
  browser: Browser
  /** Resolves a secret name for a use (the vault's resolver); the agent never sees values. */
  resolveSecret?: (name: string, use: SecretUse) => string | Promise<string>
  /** The project's secret names, and whether each has a value (never the values). */
  secrets?: () => { name: string; provided: boolean }[]
  /** Asks the user (a dialog in the app); rejects when `signal` aborts (the dialog closes). */
  requestUser: (request: UserRequest, signal: AbortSignal) => Promise<string | boolean>
  /** Values the scrubber removes from everything the agent reads (the known secret values). */
  knownValues?: () => ReadonlySet<string>
}

/** How long a step may take on a real app (Cal.com's login hydrates in more than 6 s). */
export const STEP_TIMEOUT_MS = 15_000
/** How much of a page's accessibility snapshot the agent reads at once. */
export const SNAPSHOT_MAX = 14_000

export class Studio {
  readonly options: StudioOptions
  #live: { context: BrowserContext; page: Page } | undefined

  constructor(options: StudioOptions) {
    this.options = options
  }

  get project(): OpenedProject {
    return this.options.project
  }

  /** The project for grounding: the same app and rules, at once (no human pacing). */
  get #quick(): ProjectConfig {
    const { config } = this.options
    return {
      ...config,
      defaults: {
        ...config.defaults,
        pacing: { ...config.defaults.pacing, cursor: "instant", typing: "instant", settleMs: 0 },
      },
    }
  }

  #viewport() {
    const { width, height } = this.options.config.target.viewport
    return { width, height }
  }

  /** Text the agent reads: never a known secret value in it. */
  scrub(text: string): string {
    return scrubSecrets(text, this.options.knownValues?.() ?? new Set<string>())
  }

  /** The page the agent explores and grounds on (opened at the app on first use). */
  async livePage(): Promise<Page> {
    if (this.#live === undefined || this.#live.page.isClosed()) {
      const context = await this.options.browser.newContext({ viewport: this.#viewport() })
      const page = await context.newPage()
      this.#live = { context, page }
      await page.goto(this.options.config.target.url)
    }
    return this.#live.page
  }

  /** The live page's accessibility snapshot (or one region's), with its URL. */
  async snapshot(within?: unknown): Promise<string> {
    const page = await this.livePage()
    let root = page.locator("body")
    if (within !== undefined) {
      const parsed = Locator.safeParse(asObject(within))
      if (!parsed.success)
        return `invalid \`within\` locator: ${formatIssue(parsed.error.issues[0])}`
      try {
        root = visibleOnly(await locatorFor(page, parsed.data)).first()
      } catch (e) {
        // A selector the secrets rules refuse (SECRETS-DESIGN §3 A8): the agent gets the reason.
        return `refused \`within\` locator: ${String(e)}`
      }
    }
    const text = await root
      .ariaSnapshot({ timeout: 5000 })
      .catch((e: unknown) => `snapshot failed: ${String(e)}`)
    const cut =
      text.length > SNAPSHOT_MAX
        ? `${text.slice(0, SNAPSHOT_MAX)}\n… (cut: ${text.length} chars; use \`within\` to look at a region)`
        : text
    return this.scrub(`url: ${new URL(page.url()).pathname}\n${cut}`)
  }

  /**
   * One item on the live page, through the real runner: an on-camera step (with its id), or a setup
   * or teardown item (an action without id, `{ preset: … }`, `{ ensure: … }`).
   */
  async runStep(input: unknown, scene: string, signal: AbortSignal): Promise<string> {
    const raw = asObject(input)
    if (typeof raw !== "object" || raw === null) {
      return "invalid step: expected an object like {id: open-new, action: click, target: {...}}"
    }
    const step = Step.safeParse(raw)
    const setupItem = step.success ? undefined : SetupItem.safeParse(raw)
    if (!step.success && setupItem?.success !== true) {
      // Parsed against the shape the agent meant (a union's error only says "Invalid input").
      const r = raw as Record<string, unknown>
      const [what, schema] =
        "preset" in r
          ? (["preset", PresetRef] as const)
          : "ensure" in r
            ? (["ensure", Ensure] as const)
            : "id" in r
              ? (["step", Step] as const)
              : (["setup action", Action] as const)
      const result = schema.safeParse(raw)
      return `invalid ${what}: ${result.success ? "?" : formatIssue(result.error.issues[0])}`
    }
    const scenario: Scenario =
      step.success || setupItem?.data === undefined
        ? { version: 1, steps: step.success ? [step.data] : [] }
        : { version: 1, setup: [setupItem.data], steps: [] }
    const page = await this.livePage()
    try {
      await runScenario(page, scenario, this.#quick, this.#run(scene, signal))
      return `ok. url: ${new URL(page.url()).pathname}`
    } catch (error) {
      return this.scrub(failure(error))
    }
  }

  /** The scenario the agent wrote, checked: parsed, against the project, 5–15 on-camera steps. */
  check(yaml: string): { scenario: Scenario } | { error: string } {
    let scenario: Scenario
    try {
      scenario = parseScenarioYaml(yaml)
    } catch (error) {
      return { error: `invalid scenario: ${String(error).slice(0, 1500)}` }
    }
    const issues = checkScenarioAgainstProject(scenario, this.options.config)
    if (issues.length > 0) return { error: `invalid scenario: ${issues.join("; ")}` }
    if (scenario.steps.length < 5 || scenario.steps.length > 15) {
      return { error: `a scene has 5-15 on-camera steps (this one has ${scenario.steps.length})` }
    }
    return { scenario }
  }

  /** Replays a scenario from scratch in a fresh browser (the grounding check): "ok" or why not. */
  async replay(scenario: Scenario, scene: string, signal: AbortSignal): Promise<string> {
    const context = await this.options.browser.newContext({ viewport: this.#viewport() })
    try {
      await runScenario(await context.newPage(), scenario, this.#quick, this.#run(scene, signal))
      return "ok"
    } catch (error) {
      return this.scrub(`replay failed: ${failure(error)}`)
    } finally {
      await context.close().catch(() => undefined)
    }
  }

  /**
   * Records a scene into the take store (human pacing, a fresh browser), then generates its
   * composition from the take and saves it with the scene.
   */
  async record(sceneId: string, signal: AbortSignal): Promise<string> {
    const stored = this.project.scenes.get(sceneId)
    if (stored?.scenario === undefined) return `no scene "${sceneId}" with a scenario to record`
    const { scenario } = stored
    const { config, takes } = this.options
    const dir = takes.newTakeDir(this.project.project.id, sceneId)
    const context = await this.options.browser.newContext({
      viewport: this.#viewport(),
      deviceScaleFactor: config.target.viewport.deviceScaleFactor,
    })
    let recorded: Awaited<ReturnType<typeof recordScenario>> | undefined
    let failed: string | undefined
    try {
      recorded = await recordScenario(await context.newPage(), scenario, config, {
        ...this.#run(sceneId, signal),
        outDir: dir,
      })
    } catch (error) {
      failed = failure(error)
    } finally {
      await context.close().catch(() => undefined)
    }
    const take = takes.settle(dir)
    if (take === undefined || recorded === undefined) {
      return this.scrub(`recording failed: ${failed ?? "no complete take"}`)
    }
    const { composition, warnings } = generate(config, scenario, recorded)
    saveScene(this.project, stored.scene, { composition })
    const notes = [...recorded.warnings, ...warnings]
    return this.scrub(
      `recorded (${Math.round(take.meta.durationMs / 100) / 10} s)` +
        (notes.length > 0 ? `; warnings: ${notes.join("; ")}` : ""),
    )
  }

  /** Closes the live page (the browser is the host's). */
  async close(): Promise<void> {
    await this.#live?.context.close().catch(() => undefined)
    this.#live = undefined
  }

  #run(sceneId: string, signal: AbortSignal) {
    const { resolveSecret, requestUser } = this.options
    return {
      scope: this.project.project.id,
      sceneId,
      signal,
      timeoutMs: STEP_TIMEOUT_MS,
      ...(resolveSecret !== undefined && { resolveSecret }),
      // A risky step (a delete, a send) runs only if the user approves it, then and there.
      approveRisky: async (step: StepRef) =>
        (await requestUser(
          {
            kind: "approve-risky",
            scene: sceneId,
            step: step.stepId ?? `${step.phase}[${step.index}]`,
            action: step.action,
          },
          signal,
        )) === true,
    }
  }
}

/** A step failure as the agent reads it. */
function failure(error: unknown): string {
  return error instanceof StepError
    ? `failed (${error.reason}): ${error.message}`
    : `failed: ${String(error)}`
}

/** One zod issue as the agent reads it. */
function formatIssue(issue: { message: string; path: PropertyKey[] } | undefined): string {
  return `${issue?.message ?? "?"}${issue?.path.length ? ` at ${issue.path.map(String).join(".")}` : ""}`
}

/** Models sometimes send an object as a JSON or YAML string: both are accepted. */
function asObject(raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    try {
      return parseYaml(raw) as unknown
    } catch {
      return raw
    }
  }
}
