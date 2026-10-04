import { generate } from "@kiframe/generators"
import { type OpenedProject, saveScene, syncPins, type TakeStore } from "@kiframe/project"
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
  type ElementHint,
  documentOf,
  isPageGone,
  type Lasting,
  lastingLocator,
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
  typesSecret,
  SetupItem,
  Step,
} from "@kiframe/schema"
import type { Browser, BrowserContext, ElementHandle, Page } from "playwright"
import { parse as parseYaml } from "yaml"
import {
  asWritten,
  isCyclic,
  REF,
  type RefAt,
  refsAt,
  refsOf,
  sameNode,
  type SnapshotNode,
  withAt,
} from "./refs.ts"

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
export const SNAPSHOT_MAX = 20_000

export class Studio {
  readonly options: StudioOptions
  #live: { context: BrowserContext; page: Page } | undefined
  /** The last snapshot: its page, and what it said of each ref (any new snapshot replaces it). */
  #snapshot:
    | {
        page: Page
        /** What it was of (the page's body, or the agent's region): a ref is checked there again. */
        root: ReturnType<Page["locator"]>
        /** Whether it was of the agent's region (`within`), not the whole page. */
        region: boolean
        doc: number
        refs: Map<string, SnapshotNode>
      }
    | undefined
  /** The fresh snapshot a batch's refs were just checked in (its first step's, nothing between). */
  #checked: Map<string, SnapshotNode> | undefined
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

  #where(url: string, site?: Site): string {
    return whereOf(url, this.options.config.target.url, site)
  }

  /** A step done, and where its page is: a page that failed to load makes it a failure. */
  #landed(url: string, said: string): StepResult {
    const site = siteOf(url, this.options.config.target.url)
    if (site === "unloaded") {
      return {
        ok: false,
        text: "failed (page-not-loaded): the page failed to load: try again",
        site,
      }
    }
    return { ok: true, text: `${said}. url: ${this.#where(url, site)}`, site }
  }

  /** The live page's accessibility snapshot (or one region's), with its URL. */
  async snapshot(within?: unknown): Promise<StepResult> {
    // Its refs are gone whatever this one gives (as Playwright's are).
    this.#snapshot = undefined
    this.#checked = undefined
    const page = await this.livePage()
    let root = page.locator("body")
    if (within !== undefined) {
      const parsed = Locator.safeParse(asObject(within))
      if (!parsed.success)
        return failed(`invalid \`within\` locator: ${formatIssue(parsed.error.issues[0])}`)
      try {
        root = visibleOnly(await locatorFor(page, parsed.data)).first()
      } catch (e) {
        // A selector the secrets rules refuse (SECRETS-DESIGN §3 A8): the agent gets the reason.
        return failed(`refused \`within\` locator: ${String(e)}`)
      }
      // A region still showing up (a dialog animating in) is waited for, as a snapshot did.
      const shown = await root
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true)
        .catch(() => false)
      if (!shown) {
        return failed(
          "no visible element matches the `within` locator: snapshot the page, or another region",
        )
      }
    }
    let text: string
    // Why its refs can't be used, if they can't (said with the snapshot).
    let unusable = ""
    try {
      // With refs (`[ref=e12]`): the agent can point at an element, and run_step writes its locator.
      // Its document, read on both sides: a ref holds only in the document it was given in.
      const doc = await documentOf(page)
      text = await root.ariaSnapshot({ timeout: 5000, mode: "ai" })
      const after = await documentOf(page)
      const refs = refsOf(text)
      if (doc === undefined || after === undefined) {
        unusable = "the page's document couldn't be read"
      } else if (doc !== after) {
        unusable = "the page loaded a new document as this was taken"
      } else if (refs === undefined) {
        unusable = "its refs couldn't be read"
      } else {
        this.#snapshot = { page, root, region: within !== undefined, doc, refs }
      }
    } catch (e) {
      return failed(`snapshot failed: ${this.scrub(String(e))}`)
    }
    // Scrubbed whole, then cut (a value the cut splits would pass the scrubber in part).
    const scrubbed = this.scrub(text)
    const cut =
      scrubbed.length > SNAPSHOT_MAX
        ? `${scrubbed.slice(0, SNAPSHOT_MAX)}\n… (cut: ${scrubbed.length} chars; use \`within\` to look at a region)`
        : scrubbed
    const note =
      unusable === ""
        ? ""
        : `\n(${unusable}: its refs can't be used; snapshot again to point at them, or write locators)`
    return { ok: true, text: `url: ${this.#where(page.url())}${note}\n${cut}` }
  }

  /**
   * Why the refs in these items can't be used at all, checked before any of them runs, each against
   * a fresh snapshot of the page (in Playwright's own model): see `#refusedNow` and `#refused`.
   */
  async refusedRefs(items: unknown, signal: AbortSignal): Promise<string | undefined> {
    this.#checked = undefined
    const refs = refsAt(items)
    const now = this.#refusedNow(refs)
    if (now !== undefined || refs.length === 0) return now
    const fresh = await this.#fresh(await this.livePage(), refs, signal)
    if ("error" in fresh) return fresh.error
    for (const { ref } of refs) {
      const why = this.#refused(ref, fresh.nodes)
      if (why !== undefined) return `ref ${ref}: ${why}`
    }
    // The first step runs next, nothing in between: its refs are checked in this very snapshot.
    this.#checked = fresh.nodes
    return undefined
  }

  /** What the refs say on their own: alone, of the last snapshot, of the live page. */
  #refusedNow(refs: RefAt[]): string | undefined {
    for (const { ref, extra } of refs) {
      if (extra.length > 0) {
        return `ref ${ref}: a ref goes alone ({ ref: ${ref} }), without ${extra.join(", ")}`
      }
      if (!REF.test(ref) || this.#snapshot?.refs.has(ref) !== true) {
        return `ref ${ref}: not a ref of the last snapshot: take a snapshot and use one of its [ref=…]`
      }
      if (this.#snapshot.page !== this.currentPage) {
        return `ref ${ref}: the last snapshot was of another page than the live one: take a snapshot of this one`
      }
    }
    return undefined
  }

  /**
   * A fresh snapshot of the live page, for checking refs (never shown): of the agent's snapshot's
   * document (a navigation or reload starts refs over: a new e5 may be another row's Delete), with
   * every ref asked for, waiting a moment for one missing (Playwright gives no ref to what can't be
   * clicked: a closing dialog's `pointer-events: none`).
   */
  async #fresh(
    page: Page,
    refs: RefAt[],
    signal: AbortSignal,
  ): Promise<{ nodes: Map<string, SnapshotNode> } | { error: string }> {
    const deadline = Date.now() + 1500
    const root = this.#snapshot?.root
    for (;;) {
      signal.throwIfAborted()
      const doc = await documentOf(page)
      if (doc === undefined || doc !== this.#snapshot?.doc) {
        return {
          error:
            "the page loaded a new document since the snapshot (a navigation or a reload): take a new snapshot",
        }
      }
      // The whole page (a ref keeps its number in the document, whatever the snapshot was of); the
      // agent's region if the page is too large for it.
      let text: string | undefined
      const body = page.locator("body")
      for (const of of root !== undefined && this.#snapshot?.region === true
        ? [body, root]
        : [body]) {
        if (text !== undefined) continue
        text = await of.ariaSnapshot({ timeout: 5000, mode: "ai" }).catch(() => undefined)
      }
      // A navigation while it was taken is said as one (never "too large").
      if (text === undefined && (await documentOf(page)) !== doc) continue
      if (text === undefined) {
        return {
          error:
            "the page couldn't be checked against the snapshot (too large or busy): snapshot `within` a smaller region, then point at its refs",
        }
      }
      const nodes = refsOf(text)
      if (nodes === undefined) return { error: "the page's snapshot couldn't be read: try again" }
      if ((await documentOf(page)) !== doc) continue
      if (refs.every((r) => nodes.has(r.ref)) || Date.now() > deadline) return { nodes }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  /** Why a ref is no use in a fresh snapshot of the same document: gone, in an iframe, changed. */
  #refused(ref: string, nodes: Map<string, SnapshotNode>): string | undefined {
    const saw = this.#snapshot?.refs.get(ref)
    const now = nodes.get(ref)
    if (saw === undefined) return "not a ref of the last snapshot"
    if (now === undefined) {
      return "it isn't on the page now, or can't be acted on (hidden, or under `pointer-events: none`): take a new snapshot"
    }
    if (saw.inFrame || now.inFrame) {
      return "it's inside a frame (an iframe): steps reach the page's own elements only"
    }
    // Never what it says now: it may show a value typed by a step (a secret).
    if (!sameNode(saw, now)) return "it changed since the snapshot: take a new snapshot"
    return undefined
  }

  /**
   * One item on the live page, through the real runner: an on-camera step (with its id), or a setup
   * or teardown item (an action without id, `{ preset: … }`, `{ ensure: … }`). Its refs become
   * lasting locators first, the page as it is right now, and a result that worked says the item as
   * it's written in the YAML.
   */
  async runStep(
    input: unknown,
    scene: string,
    signal: AbortSignal,
    part: ScenarioPart = "steps",
  ): Promise<StepResult> {
    const raw = asObject(input)
    if (isCyclic(raw))
      return failed("invalid step: a YAML alias refers to itself (or it nests too deep)")
    const refs = refsAt(raw)
    if (refs.length === 0) {
      this.#checked = undefined
      return this.#runItem(raw, scene, signal, part)
    }
    const refused = this.#refusedNow(refs)
    if (refused !== undefined) return failed(refused)
    const written = await this.#written(raw, refs, part, signal)
    if ("error" in written) return failed(written.error)
    const result = await this.#runItem(written.value, scene, signal, part)
    // Only a step that worked is one to write (a failed one's locator isn't confirmed).
    if (!result.ok) return result
    return {
      ...result,
      text: `${result.text}\nas written: ${this.scrub(asWritten(written.value))}`,
    }
  }

  /**
   * The item with each ref replaced by its lasting locator: one that finds the very element the
   * agent pointed at and nothing else, checked right before the step runs; a look-alike in its row
   * (`in`), where the item takes one (never a place among look-alikes).
   */
  async #written(
    raw: unknown,
    refs: RefAt[],
    part: ScenarioPart,
    signal: AbortSignal,
  ): Promise<{ value: unknown } | { error: string }> {
    const page = await this.livePage()
    // The page as it is right now (the steps before changed it): each ref checked in a fresh
    // snapshot, and resolved against it (no other snapshot in between: it'd replace Playwright's refs).
    const checked = this.#checked
    this.#checked = undefined
    const fresh = checked !== undefined ? { nodes: checked } : await this.#fresh(page, refs, signal)
    if ("error" in fresh) return { error: `ref ${refs[0]?.ref ?? ""}: ${fresh.error}` }
    // Built now: a value typed by the step before is a known value by this one.
    const scrub = this.scrubber()
    const allowed = (text: string) => scrub(text) === text
    let value = raw
    for (const at of refs) {
      const why = this.#refused(at.ref, fresh.nodes)
      if (why !== undefined) return { error: `ref ${at.ref}: ${why}` }
      const hint = fresh.nodes.get(at.ref)
      if (hint === undefined) continue // never: #refused said it's there
      // A page that moves while it's read (a redirect finishing): said as such; anything else with
      // its own words.
      // A row may tell a look-alike apart only where the item's own schema takes one (a target:
      // never a condition's locator).
      const item = value
      const rows = () => takesRow(item, at.path, part)
      const lasting = await lastingOfRef(page, at.ref, hint, allowed, rows).catch(
        (error: unknown): Lasting => ({
          error: isPageGone(error)
            ? "the page changed while it was read: take a new snapshot"
            : `it couldn't be read: ${this.scrub(error instanceof Error ? error.message : String(error))}`,
        }),
      )
      if ("error" in lasting) return { error: `ref ${at.ref}: ${lasting.error}` }
      value = withAt(
        value,
        at.path,
        lasting.in === undefined ? lasting.locator : { ...lasting.locator, in: lasting.in },
      )
    }
    return { value }
  }

  async #runItem(
    raw: unknown,
    scene: string,
    signal: AbortSignal,
    part: ScenarioPart,
  ): Promise<StepResult> {
    if (typeof raw !== "object" || raw === null) {
      return failed(
        "invalid step: expected an object like {id: open-new, action: click, target: {...}}",
      )
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
      return failed(
        `invalid teardown action: ${formatIssue(teardownItem.error.issues[0])}${shapeOf(raw)}`,
      )
    }
    if (teardownItem === undefined && !step.success && setupItem?.success !== true) {
      const r = raw as Record<string, unknown>
      if (part === "steps" && !("id" in r) && Action.safeParse(raw).success) {
        return failed(
          "invalid step: an on-camera step needs an id (a setup or teardown action: give its part)",
        )
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
      return failed(
        `invalid ${what}: ${result.success ? "?" : formatIssue(result.error.issues[0])}${shapeOf(raw)}`,
      )
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
        return failed(
          "it closed every page: the next tool opens the app fresh (signed out, nothing kept)",
        )
      }
      return this.#landed(now.url(), "ok")
    } catch (error) {
      // Stopped: the call is aborted, not a failure to fix.
      if (isStopped(error)) throw error
      // The item closed the popup this run started on: its opener, still open, is live again.
      // Done if it was one step; an item of several (a preset) stopped there.
      const back =
        error instanceof StepError && error.reason === "page-closed" ? this.#backPage() : undefined
      if (back !== undefined) {
        return step.success || !("preset" in raw || "ensure" in raw)
          ? this.#landed(back.url(), "ok (the page closed itself: back on the page that opened it)")
          : failed(
              `failed (page-closed): ${(error as StepError).message}; the rest of it didn't run (back on the page that opened it, url: ${this.#where(back.url())}): run its remaining steps one by one`,
            )
      }
      // An ensure checked alone doesn't know the scene's teardown or setup: said so.
      const alone =
        "ensure" in (raw as Record<string, unknown>)
          ? " (ensure checked alone: your teardown and setup aren't known here; save_scene's replay runs them)"
          : ""
      return failed(failure(error) + alone)
    }
  }

  /** The scenario the agent wrote, checked: parsed, against the project, 5–15 on-camera steps. */
  check(yaml: string): { scenario: Scenario } | { error: string } {
    let scenario: Scenario
    try {
      scenario = parseScenarioYaml(yaml)
    } catch (error) {
      // A ref is the live page's (run_step's) only, and the schema refuses it: said as such.
      const parsed = asObject(yaml)
      const refs = isCyclic(parsed) ? [] : [...new Set(refsAt(parsed).map((r) => r.ref))]
      if (refs.length > 0) {
        return {
          error: `invalid scenario: a ref (${refs.join(", ")}) is only for run_step on the live page: write the locator its result gave ("as written: …")`,
        }
      }
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
  async record(sceneId: string, signal: AbortSignal): Promise<StepResult> {
    const stored = this.project.scenes.get(sceneId)
    if (stored?.scenario === undefined)
      return failed(`no scene "${sceneId}" with a scenario to record`)
    if (stored.scene.source.kind !== "recording") {
      return failed(
        `scene "${sceneId}" is a ${stored.scene.source.kind} scene: only recordings are filmed`,
      )
    }
    const { scenario } = stored
    const { config, takes } = this.options
    const dir = takes.newTakeDir(this.project.project.id, sceneId)
    const context = await this.options.browser.newContext({
      viewport: this.#viewport(),
      deviceScaleFactor: config.target.viewport.deviceScaleFactor,
    })
    let recorded: Awaited<ReturnType<typeof recordScenario>> | undefined
    let why: string | undefined
    let stopped: StepError | undefined
    try {
      recorded = await recordScenario(await context.newPage(), scenario, config, {
        ...this.#run(sceneId, signal),
        outDir: dir,
      })
    } catch (error) {
      if (isStopped(error)) stopped = error as StepError
      why = failure(error)
    } finally {
      await context.close().catch(() => undefined)
    }
    let take: Awaited<ReturnType<TakeStore["settle"]>>
    try {
      take = await takes.settle(dir)
    } catch (error) {
      if (stopped !== undefined) throw stopped
      return failed(`recording failed: ${why ?? failure(error)}`)
    }
    if (stopped !== undefined) throw stopped
    if (take === undefined || recorded === undefined) {
      // A complete take the recorder failed after (a file error) is kept, but without its result
      // no composition is made from it: filmed again.
      const kept = take !== undefined ? " (its take was kept, but record again)" : ""
      return failed(`recording failed: ${why ?? "no complete take"}${kept}`)
    }
    let made: ReturnType<typeof generate>
    try {
      made = generate(config, scenario, recorded)
      saveScene(this.project, stored.scene, { composition: made.composition })
    } catch (error) {
      return failed(
        `recorded, but its composition wasn't saved (the take was kept): ${String(error)}`,
      )
    }
    // The new take is the scene's (pinned); the one before is scratch, evicted beyond the budget.
    try {
      syncPins(this.project, takes)
      takes.evict()
    } catch {
      // The pins are synced again when the project opens; the budget at the next recording.
    }
    const { warnings } = made
    const notes = [...recorded.warnings, ...warnings]
    return {
      ok: true,
      text:
        `recorded (${Math.round(take.meta.durationMs / 100) / 10} s)` +
        (notes.length > 0 ? `; warnings: ${notes.join("; ")}` : ""),
    }
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
  // A preset or an ensure isn't an action: its own error is the whole answer.
  if ("preset" in raw || "ensure" in raw) return ""
  if (typeof kind !== "string" || !Object.hasOwn(ACTION_REFERENCE, kind)) {
    return `\nactions: ${Object.keys(ACTION_REFERENCE).join(", ")}`
  }
  return `\n${actionReference(kind as ActionKind)}`
}

/**
 * Where a page is, against the app's address (read from the URLs, never from text): the app's
 * origin; the app's own host under `www.` or upgraded from http to https (a redirect: the app, but
 * a secret is typed on the exact origin only); another site; or Chromium's error page (the load
 * failed). A blob: URL is its creator's origin; data: and file: pages are another site.
 */
export type Site = "app" | "app-redirect" | "other" | "unloaded"

export function siteOf(url: string, appUrl: string): Site {
  let page: URL
  try {
    page = new URL(url)
  } catch {
    return "other"
  }
  if (page.protocol === "chrome-error:") return "unloaded"
  if (page.protocol === "about:") return "app"
  const app = new URL(appUrl)
  if (page.origin === app.origin) return "app"
  if (page.origin === "null") return "other"
  const host = (u: URL) => new URL(u.origin).host.replace(/^www\./, "")
  const protocol = (u: URL) => new URL(u.origin).protocol
  const upgraded =
    protocol(page) === protocol(app) || (protocol(app) === "http:" && protocol(page) === "https:")
  return host(page) === host(app) && upgraded ? "app-redirect" : "other"
}

/** A step's outcome: ok or not, what the agent reads, and where the page is (when it was read). */
export interface StepResult {
  ok: boolean
  text: string
  site?: Site
}

/**
 * Where a page is, as the agent reads it: its path (never its query: it may hold a value), and
 * what its site is when it isn't the app's own origin (`siteOf`).
 */
export function whereOf(url: string, appUrl: string, site = siteOf(url, appUrl)): string {
  if (site === "unloaded") return "(the page failed to load: try again)"
  let page: URL
  try {
    page = new URL(url)
  } catch {
    return "(an unreadable address: not the app)"
  }
  // A blank page (a popup not loaded yet, the first page before a goto): the app's, but empty.
  if (page.protocol === "about:") return "(a blank page)"
  if (site === "app") return page.pathname
  const app = new URL(appUrl)
  if (page.origin === "null") return `(a ${page.protocol.replace(":", "")} page: not the app)`
  const shown = new URL(page.origin)
  return site === "app-redirect"
    ? `${page.pathname} (on ${shown.origin}: the app's address redirects here; the user should set the project's address to ${shown.origin}, or secrets can't be typed on this page)`
    : `${page.pathname} (on ${shown.host}: NOT the app's site, ${app.host})`
}

/** Where in a scenario an item runs. */
export type ScenarioPart = "setup" | "steps" | "teardown"

/** A ref's element as the page has it now, and its lasting locator (or why none). */
async function lastingOfRef(
  page: Page,
  ref: string,
  hint: ElementHint,
  allowed: (text: string) => boolean,
  rows: () => boolean,
): Promise<Lasting> {
  // As the page is now, without waiting: `elementHandle()` waits for something on some apps (1.6 s
  // on Cal.com's login page: FAILURE-CATALOGUE #21). A ref names an element, never a text node.
  const handles = (await page
    .locator(`aria-ref=${ref}`)
    .elementHandles()
    .catch(() => [])) as ElementHandle<Element>[]
  try {
    const [handle] = handles
    if (handle === undefined) {
      return { error: "it isn't on the page anymore (the page changed): take a new snapshot" }
    }
    return await lastingLocator(page, handle, hint, allowed, { rows })
  } finally {
    await Promise.all(handles.map((h) => h.dispose().catch(() => undefined)))
  }
}

/**
 * Whether the item's own schema takes a target in a row at a ref's place: a probe target with `in`
 * put there adds no issue at that place (a step's target does; a condition's locator doesn't).
 */
function takesRow(item: unknown, path: (string | number)[], part: ScenarioPart): boolean {
  // A step typing a secret: its target never has a row (§3 A2), whatever else the item says (a
  // refinement doesn't run while another field is wrong).
  const r = item as { action?: unknown; value?: unknown }
  if (
    typeof r.action === "string" &&
    typesSecret({ ...r, action: r.action }) &&
    path[0] === "target"
  ) {
    return false
  }
  const probe = { by: "role", role: "button", in: { role: "listitem", has: "x" } }
  const plain = { by: "role", role: "button" }
  const key = (p: PropertyKey[]) => p.map(String).join(".")
  const before = new Set(issuePaths(withAt(item, path, plain), part).map(key))
  return !issuePaths(withAt(item, path, probe), part).some(
    (p) => !before.has(key(p)) && overlaps(p, path),
  )
}

/** The paths of an item's schema issues, under the schema of the part it's for (as it'll run). */
function issuePaths(item: unknown, part: ScenarioPart): PropertyKey[][] {
  const r = item as Record<string, unknown>
  const schema = part === "teardown" ? Action : part === "steps" && "id" in r ? Step : SetupItem
  return schema.safeParse(item).error?.issues.map((i) => i.path) ?? []
}

/** Whether one path is within the other (an issue at a ref's place, or around it). */
function overlaps(a: PropertyKey[], b: PropertyKey[]): boolean {
  const n = Math.min(a.length, b.length)
  return a.slice(0, n).every((k, i) => String(k) === String(b[i]))
}

/** A failed outcome. */
function failed(text: string): StepResult {
  return { ok: false, text }
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
export function asObject(raw: unknown): unknown {
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
