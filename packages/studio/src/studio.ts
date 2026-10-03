import { generate } from "@kiframe/generators"
import { type OpenedProject, saveScene, type TakeStore } from "@kiframe/project"
import {
  locatorFor,
  recordScenario,
  runScenario,
  secretScrubber,
  type SecretUse,
  type ApprovalRequest,
  knownValuesOf,
  StepError,
  type StepRef,
  visibleOnly,
} from "@kiframe/runtime"
import {
  ACTION_REFERENCE,
  type ActionKind,
  actionReference,
  Action,
  checkScenarioAgainstProject,
  Ensure,
  Locator,
  parseScenarioYaml,
  PresetRef,
  type ProjectConfig,
  type Scenario,
  SceneId,
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
  /**
   * The host's id for the project folder: the scope of its approvals (SECRETS-DESIGN §3 A1; never
   * project.json's id, which the agent or a copied folder could set).
   */
  scope: string
  /**
   * The host's id for a scene (the approvals' scene part): stable for a scene, new for a new scene
   * even when it reuses a deleted scene's id (A1; never the agent's string itself). Kebab-case
   * (a `SceneId`: the runtime refuses another).
   */
  sceneKey: (sceneId: string) => string
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
  /**
   * Asks the user to approve a secret's use (the vault's approval: A3), in the app; rejects when
   * `signal` aborts (a stop closes the dialog: the secret is never typed after it).
   */
  requestApproval?: (request: ApprovalRequest, signal: AbortSignal) => boolean | Promise<boolean>
  /**
   * The known secret values (every value the project's scenes can use, R6): the scrubber removes
   * them from everything the agent reads, and recordings blur them on screen.
   */
  knownValues?: () => ReadonlySet<string>
}

/** How long a step may take on a real app (Cal.com's login hydrates in more than 6 s). */
export const STEP_TIMEOUT_MS = 15_000
/** How much of a page's accessibility snapshot the agent reads at once. */
export const SNAPSHOT_MAX = 14_000

export class Studio {
  readonly options: StudioOptions
  #live: { context: BrowserContext; page: Page } | undefined
  /** Aborted when the studio closes: every tool and dialog stops (the tools' signal includes it). */
  readonly #lifetime = new AbortController()
  /** The live page being opened (one at a time: a second caller waits for it). */
  #opening: Promise<Page> | undefined

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

  /**
   * A scrubber for text the agent reads: never a known secret value in it (the host's, and the live
   * page's, as they are now). Built once for a whole result (the tools' boundary).
   */
  scrubber(): (text: string) => string {
    const values = new Set(this.options.knownValues?.() ?? [])
    if (this.#live !== undefined) for (const v of knownValuesOf(this.#live.context)) values.add(v)
    return secretScrubber(values)
  }

  /** One text scrubbed (`scrubber`). */
  scrub(text: string): string {
    return this.scrubber()(text)
  }

  /** Aborted once the studio is closed. */
  get closed(): AbortSignal {
    return this.#lifetime.signal
  }

  /**
   * The live page, when one is open: never opens one (the host's live view follows it, and the
   * page the runner switched to, a popup, when it does).
   */
  get currentPage(): Page | undefined {
    return this.#live !== undefined && !this.#live.page.isClosed() ? this.#live.page : undefined
  }

  /** The page the agent explores and grounds on (opened at the app on first use). */
  async livePage(): Promise<Page> {
    if (this.#live !== undefined && !this.#live.page.isClosed()) return this.#live.page
    // The page the runner followed may have closed (a popup): back on another page still open.
    const back = this.#backPage()
    if (back !== undefined) return back
    this.#opening ??= this.#open().finally(() => {
      this.#opening = undefined
    })
    return this.#opening
  }

  async #open(): Promise<Page> {
    await this.#live?.context.close().catch(() => undefined)
    this.#live = undefined
    const context = await this.options.browser.newContext({ viewport: this.#viewport() })
    try {
      const page = await context.newPage()
      await page.goto(this.options.config.target.url)
      // Closed meanwhile: never kept (nothing would close it).
      if (this.#lifetime.signal.aborted) throw new Error("the studio was closed")
      // Kept only once it's at the app (a failed first visit is tried again next time).
      this.#live = { context, page }
      return page
    } catch (error) {
      await context.close().catch(() => undefined)
      throw error
    }
  }

  /**
   * The live context's latest page still open (the one a closed popup's opener, or the tab before
   * it, most likely is), made the live page; undefined when none is.
   */
  #backPage(): Page | undefined {
    const back = this.#live?.context
      .pages()
      .filter((p) => !p.isClosed())
      .at(-1)
    if (this.#live !== undefined && back !== undefined) this.#live.page = back
    return back
  }

  /**
   * Where a page is, as the agent reads it: its path (never its query: it may hold a value), and
   * the site when it isn't the app's own (a link that left the app says so).
   */
  #where(url: string): string {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return url.slice(0, 200)
    }
    const app = new URL(this.options.config.target.url).origin
    if (parsed.origin === app || parsed.protocol === "about:") return parsed.pathname
    return `${parsed.pathname} (on ${parsed.host}: NOT the app's site, ${new URL(app).host})`
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
    // Scrubbed whole, then cut (a value the cut splits would pass the scrubber in part).
    const scrubbed = this.scrub(text)
    const cut =
      scrubbed.length > SNAPSHOT_MAX
        ? `${scrubbed.slice(0, SNAPSHOT_MAX)}\n… (cut: ${scrubbed.length} chars; use \`within\` to look at a region)`
        : scrubbed
    return `url: ${this.#where(page.url())}\n${cut}`
  }

  /**
   * One item on the live page, through the real runner: an on-camera step (with its id), or a setup
   * or teardown item (an action without id, `{ preset: … }`, `{ ensure: … }`).
   */
  async runStep(
    input: unknown,
    scene: string,
    signal: AbortSignal,
    part: ScenarioPart = "steps",
  ): Promise<string> {
    const raw = asObject(input)
    if (typeof raw !== "object" || raw === null) {
      return "invalid step: expected an object like {id: open-new, action: click, target: {...}}"
    }
    // Run in the part it's for: its approvals are keyed there, as the replay's will be (A1).
    const step = part === "steps" ? Step.safeParse(raw) : { success: false as const }
    // In the steps, only a preset or an ensure runs as the setup (they're setup-only).
    const setupOnly = "preset" in raw || "ensure" in raw
    const setupItem =
      step.success || part === "teardown" || (part === "steps" && !setupOnly)
        ? undefined
        : SetupItem.safeParse(raw)
    const teardownItem = part === "teardown" ? Action.safeParse(raw) : undefined
    if (teardownItem !== undefined && !teardownItem.success) {
      return `invalid teardown action: ${formatIssue(teardownItem.error.issues[0])}${shapeOf(raw)}`
    }
    if (teardownItem === undefined && !step.success && setupItem?.success !== true) {
      const r = raw as Record<string, unknown>
      if (part === "steps" && !("id" in r) && Action.safeParse(raw).success) {
        return "invalid step: an on-camera step needs an id (a setup or teardown action: give its part)"
      }
      // Parsed against the shape the agent meant (a union's error only says "Invalid input").
      const [what, schema] =
        "preset" in r
          ? (["preset", PresetRef] as const)
          : "ensure" in r
            ? (["ensure", Ensure] as const)
            : "id" in r && part === "steps"
              ? (["step", Step] as const)
              : (["setup action", Action] as const)
      const result = schema.safeParse(raw)
      // The issue, then the forms of the action it meant (never a guess at the field names).
      return `invalid ${what}: ${result.success ? "?" : formatIssue(result.error.issues[0])}${shapeOf(raw)}`
    }
    const scenario: Scenario =
      teardownItem?.success === true
        ? { version: 1, steps: [], teardown: [teardownItem.data] }
        : step.success || setupItem?.data === undefined
          ? { version: 1, steps: step.success ? [step.data] : [] }
          : { version: 1, setup: [setupItem.data], steps: [] }
    const page = await this.livePage()
    try {
      await runScenario(page, scenario, this.#quick, {
        ...this.#run(scene, signal),
        // The live page follows the tab or popup the runner switched to (the next step acts there).
        onPageSwitch: (next) => {
          if (this.#live !== undefined) this.#live.page = next
        },
      })
      const now = this.#live?.page.isClosed() === false ? this.#live.page : this.#backPage()
      if (now === undefined) {
        return "ok, but it closed every page: the next tool opens the app fresh (signed out, nothing kept)"
      }
      return `ok. url: ${this.#where(now.url())}`
    } catch (error) {
      // Stopped: the call is aborted, not a failure to fix.
      if (isStopped(error)) throw error
      // The item closed the popup this run started on: its opener, still open, is live again.
      // Done if it was one step; an item of several (a preset) stopped there.
      const back =
        error instanceof StepError && error.reason === "page-closed" ? this.#backPage() : undefined
      if (back !== undefined) {
        const url = this.#where(back.url())
        return step.success || !("preset" in raw || "ensure" in raw)
          ? `ok (the page closed itself: back on the page that opened it). url: ${url}`
          : `failed (page-closed): ${(error as StepError).message}; the rest of it didn't run (back on the page that opened it, url: ${url}): run its remaining steps one by one`
      }
      // An ensure checked alone doesn't know the scene's teardown or setup: said so.
      const alone =
        "ensure" in (raw as Record<string, unknown>)
          ? " (ensure checked alone: your teardown and setup aren't known here; save_scene's replay runs them)"
          : ""
      return failure(error) + alone
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
      if (isStopped(error)) throw error
      return `replay failed: ${failure(error)}`
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
    if (stored.scene.source.kind !== "recording") {
      return `scene "${sceneId}" is a ${stored.scene.source.kind} scene: only recordings are filmed`
    }
    const { scenario } = stored
    const { config, takes } = this.options
    const dir = takes.newTakeDir(this.project.project.id, sceneId)
    const context = await this.options.browser.newContext({
      viewport: this.#viewport(),
      deviceScaleFactor: config.target.viewport.deviceScaleFactor,
    })
    let recorded: Awaited<ReturnType<typeof recordScenario>> | undefined
    let failed: string | undefined
    let stopped: StepError | undefined
    try {
      recorded = await recordScenario(await context.newPage(), scenario, config, {
        ...this.#run(sceneId, signal),
        outDir: dir,
      })
    } catch (error) {
      if (isStopped(error)) stopped = error as StepError
      failed = failure(error)
    } finally {
      await context.close().catch(() => undefined)
    }
    let take: ReturnType<TakeStore["settle"]>
    try {
      take = takes.settle(dir)
    } catch (error) {
      if (stopped !== undefined) throw stopped
      return `recording failed: ${failed ?? failure(error)}`
    }
    if (stopped !== undefined) throw stopped
    if (take === undefined || recorded === undefined) {
      // A complete take the recorder failed after (a file error) is kept, but without its result
      // no composition is made from it: filmed again.
      const kept = take !== undefined ? " (its take was kept, but record again)" : ""
      return `recording failed: ${failed ?? "no complete take"}${kept}`
    }
    let made: ReturnType<typeof generate>
    try {
      made = generate(config, scenario, recorded)
      saveScene(this.project, stored.scene, { composition: made.composition })
    } catch (error) {
      return `recorded, but its composition wasn't saved (the take was kept): ${String(error)}`
    }
    const { warnings } = made
    const notes = [...recorded.warnings, ...warnings]
    return (
      `recorded (${Math.round(take.meta.durationMs / 100) / 10} s)` +
      (notes.length > 0 ? `; warnings: ${notes.join("; ")}` : "")
    )
  }

  /** Closes the live page (the browser is the host's); every tool and dialog still running stops. */
  async close(): Promise<void> {
    this.#lifetime.abort()
    await this.#live?.context.close().catch(() => undefined)
    this.#live = undefined
  }

  #run(sceneId: string, signal: AbortSignal) {
    const { resolveSecret, requestUser, requestApproval, scope, sceneKey, knownValues } =
      this.options
    const key = sceneKey(sceneId)
    if (!SceneId.safeParse(key).success) {
      throw new Error(`the host's scene key "${key}" isn't kebab-case (a SceneId)`)
    }
    return {
      // The host's ids, never the agent's strings or project.json's (A1).
      scope,
      sceneId: key,
      signal,
      timeoutMs: STEP_TIMEOUT_MS,
      // Every value the scene can use: blurred on screen and scrubbed even when not typed (R6).
      knownSecretValues: [...(knownValues?.() ?? [])],
      ...(resolveSecret !== undefined && { resolveSecret }),
      // Dialogs close at the stop, and never open after it.
      ...(requestApproval !== undefined && {
        requestApproval: (request: ApprovalRequest) =>
          ask(signal, () => requestApproval(request, signal)),
      }),
      // A risky step (a delete, a send) runs only if the user approves it, then and there.
      approveRisky: async (step: StepRef) => {
        const request: UserRequest = {
          kind: "approve-risky",
          scene: sceneId,
          step: step.stepId ?? `${step.phase}[${step.index}]`,
          action: step.action,
        }
        return (await ask(signal, () => requestUser(request, signal))) === true
      },
    }
  }
}

/**
 * A dialog to the host, never opened once `signal` has aborted (a host rejecting on the abort
 * event would never hear it, and the run would wait on it).
 */
async function ask<T>(signal: AbortSignal, open: () => T | Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return open()
}

const isStopped = (error: unknown) => error instanceof StepError && error.reason === "stopped"

/** The forms of the action an item meant (its `action`), for a refusal: empty if it isn't one. */
function shapeOf(raw: object): string {
  const kind = (raw as { action?: unknown }).action
  if (typeof kind !== "string" || !Object.hasOwn(ACTION_REFERENCE, kind)) {
    return `\nactions: ${Object.keys(ACTION_REFERENCE).join(", ")}`
  }
  return `\n${actionReference(kind as ActionKind)}`
}

/** Where in a scenario an item runs. */
export type ScenarioPart = "setup" | "steps" | "teardown"

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
