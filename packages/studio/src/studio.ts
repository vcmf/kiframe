import { generate } from "@kiframe/generators"
import {
  type OpenedProject,
  ProjectFiles,
  projectChangedOnDisk,
  saveProject,
  scenesNaming,
  saveScene,
  type TakeStore,
} from "@kiframe/project"
import {
  locatorFor,
  LookRefusal,
  maskedScreenshot,
  recordScenario,
  runScenario,
  secretScrubber,
  type SecretUse,
  type ApprovalRequest,
  type Box,
  type HandoverRequest,
  landingOf,
  type SessionLanding,
  checksSignedIn,
  sessionPresetsOf,
  knownValuesOf,
  addKnownValues,
  StepError,
  type StepRef,
  visibleOnly,
  type ElementHint,
  documentOf,
  isPageGone,
  type Lasting,
  lastingLocator,
  viewOf,
  fitImage,
  type FittedImage,
  ImageRefusal,
  viewportOf,
  type ElectronTarget,
  placeOf,
  type RunOptions,
} from "@kiframe/runtime"
import {
  ACTION_REFERENCE,
  type ActionKind,
  appOf,
  actionReference,
  Action,
  isOffCameraOnly,
  OFF_CAMERA_MESSAGE,
  checkScenarioAgainstProject,
  Locator,
  parseScenarioYaml,
  PresetRef,
  Preset,
  Project,
  type ProjectConfig,
  type Scenario,
  SceneId,
  typesSecret,
  SetupItem,
  Step,
  sameApp,
  WebApp,
  webAppsOf,
  firstApp,
  startAppOf,
  type TakeMeta,
} from "@kiframe/schema"
import type { Browser, BrowserContext, ElementHandle, Page } from "playwright"
import { parse as parseYaml } from "yaml"
import { appCard } from "./add-app.ts"
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
import { findInSnapshot } from "./snapshot-find.ts"

// The studio: what the agent's tools act on (the project, the live app, the take store), for one
// open project. The host (the desktop app's main process) makes one per project and passes it to
// the agent as the tools' context. Ported from the P0-8 grounding script.

/** What the agent may ask the user, and what comes back. A request rejects at the stop. */
export type UserRequest =
  | { kind: "question"; question: string }
  | { kind: "approve-risky"; scene: string; step: string; action: string }
  /** Add a site to the project's apps (`add_app`): the card is built from what would be written. */
  | ({ kind: "approve-app" } & AppCard)
  /** Delete a page's file, or replace a whole file the agent didn't write (the file tools). */
  | { kind: "approve-file"; action: "delete" | "replace"; path: string }
  /**
   * The user takes the live browser for a moment (`hand_over`): `task` is the agent's words, so the
   * card shows the page's own origin beside it (`onApp`: one of the project's apps), never only them.
   */
  | {
      kind: "handover"
      task: string
      doneWhen?: string
      origin: string
      onApp: boolean
      /** Where: the live app (the agent's), a scene being checked (a replay), or being recorded. */
      where: "live" | "check" | "record"
      scene?: string
    }

/** The user's answer to a handover: done or not, and a note for the agent (scrubbed). */
export interface HandoverAnswer {
  outcome: "done" | "declined"
  note: string
  /** What they typed hidden from the agent from now on (the host makes it known before answering). */
  hide: boolean
}

/** What a request is answered with: text, a yes or no, a handover's end. */
export type UserAnswer = string | boolean | HandoverAnswer

/** A browser context's saved state (cookies, local storage, IndexedDB). */
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>
/** The session presets a saved sign-in holds: each its key (steps, apps) and where it ended. */
type SessionPresets = Map<string, { key: string; landing: SessionLanding }>

/**
 * A scene's on-camera steps: most are 5-15 (one idea); one that builds something step by step (a
 * drawing, a form filled in full) may take up to 50 (decided by the user, 2026-10-08).
 */
export const SCENE_STEPS = { min: 5, max: 50 } as const

/** At most this long a run's context waits for a handover's end before it closes. */
const SETTLE_HANDOVER_MS = 8000

/** The shortest secret value checked in what the agent writes (`Studio.secretTest`). */
const MIN_CHECKED = 4

/** What the agent knows of one of the project's files (`StudioOptions.fileReads`). */
export interface FileNote {
  hash: string
  /** It saw the whole file in one read, nothing scrubbed out (a replace: this, or `mine`). */
  full: boolean
  /** The agent made these bytes this session (it knows them: replacing them asks no one). */
  mine: boolean
}

/**
 * A site the agent asks to add, as the user approves it: the address as the browser will use it
 * (`host`: punycode and port included, never decoded), what's notable about it, and the agent's
 * reason (cleaned: one line of plain text, said as the agent's words).
 */
export interface AppCard {
  name: string
  url: string
  host: string
  /** http: (not encrypted). */
  plain: boolean
  /** A punycode label (`xn--`): it may look like another site's name. */
  lookalike: boolean
  /** On this computer or its local network. */
  local: boolean
  /**
   * Secrets saved for this site (the vault keeps them across projects): they come with it, each use
   * still asked. Undefined when the vault didn't read.
   */
  secrets?: number
  /** Scenes that already name this app (it was removed, then added again): they'll open this site. */
  usedBy: string[]
  why: string
}

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
  /** The secrets usable on an app's exact origin (names, never values), asked app by app. */
  secrets?: (origin: string) => { name: string; provided: boolean }[]
  /** Asks the user (a dialog in the app); rejects when `signal` aborts (the dialog closes). */
  requestUser: (request: UserRequest, signal: AbortSignal) => Promise<UserAnswer>
  /** Where a site's address really lands (its www. or https form), as a project's first app's. */
  resolveAddress?: (url: string) => Promise<string>
  /**
   * What the agent read of the project's files (canonical path → its hash, whether it saw the whole
   * file unscrubbed, whether the agent itself wrote it): the host's, so it outlives a studio remade
   * when its browser dies, gone with the project.
   */
  fileReads?: Map<string, FileNote>
  /** Keeps a file's bytes before the agent replaces or deletes it (until history: M1-10). */
  keepVersion?: (path: string, bytes: Uint8Array) => void
  /**
   * Every handover's end settled (what the user typed read and made known): a check's or a
   * recording's context closes only after it (a stop mid-handover reads its fields first).
   */
  handoversSettled?: () => Promise<void>
  /**
   * Ends the run, said in the chat: the agent wrote a secret's value itself (a guess at it: one per
   * run, never a guessing game). Every host gives it.
   */
  stopRun: (why: string) => void
  /**
   * Whether the model takes images (the host asks its provider; a model picker may change it). None:
   * it does (tests, scripts). When it doesn't, no tool sends one: `look` and an image's read refuse.
   */
  seesImages?: () => Promise<boolean>
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
  /**
   * After a scene is recorded (its composition saved): the host's take bookkeeping (eviction).
   * None: nothing is ever evicted (tests, a CLI that knows one project only).
   */
  afterRecord?: () => void
  /**
   * Launches the project's desktop app `app` (the host's: from its approval, confined), with the
   * build a take keeps. A refusal the user settles (in the Apps panel) has `needsUser`. None:
   * desktop apps can't be grounded or recorded (a CLI, tests of web apps).
   */
  launchDesktop?: (
    app: string,
    signal: AbortSignal,
  ) => Promise<{ target: ElectronTarget; build: NonNullable<TakeMeta["appBuild"]> }>
}

/** How long a step may take on a real app (Cal.com's login hydrates in more than 6 s). */
export const STEP_TIMEOUT_MS = 15_000
/** How much of a page's accessibility snapshot the agent reads at once. */
export const SNAPSHOT_MAX = 20_000

export class Studio {
  readonly options: StudioOptions
  /**
   * The live page: its context and page, the app it's at, and (a desktop app) its launched target,
   * closed whole with it.
   */
  #live:
    | { context: BrowserContext; page: Page; app: string | undefined; target?: ElectronTarget }
    | undefined
  /** Said with the next tool's result once (a desktop app that quit, launched again). */
  #notice: string | undefined
  /**
   * The saved sign-in (memory only, gone with the studio: it holds a session's cookies): one
   * browser state, and the session presets it holds (each its key: its steps and the apps as they
   * were; its landing: where it ended). Checks and recordings start from it (SECRETS-DESIGN §5b).
   */
  #session:
    | { state: StorageState; presets: Map<string, { key: string; landing: SessionLanding }> }
    | undefined
  /** What the user typed during handovers (made known for the studio's life: never stored). */
  readonly #typed = new Set<string>()
  /** The page a check's or a recording's handover gave the user (the live view follows it). */
  #handoverPage: Page | undefined
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
  /**
   * Where the live page opens: the first web app, as the project's apps are now (a desktop app has
   * its own driver, next).
   */
  get #start(): WebApp | undefined {
    return Object.values(this.options.config.apps).find((a): a is WebApp => a.kind === "web")
  }
  #files: ProjectFiles | undefined
  #fileReads: Map<string, FileNote> | undefined

  /** Each scene's start app its steps last ran in (by scene id): its next steps mean it too. */
  readonly #sceneApps = new Map<string, string>()

  /** The start app a scene's steps ran in (undefined: none ran). */
  groundedApp(scene: string): string | undefined {
    return this.#sceneApps.get(scene)
  }

  /** Sites the user declined this session (their addresses): never asked again, in any form. */
  readonly #declined: string[] = []
  /** add_app cards shown this session (at most `MAX_APP_ASKS`). */
  #appAsks = 0

  /**
   * Adds a site to the project's apps, if the user allows it (OBJECT-MODEL §0.9): the address
   * resolved as a first app's, the whole project checked before asking (never an Allow that can't
   * be saved), written to project.json, and the studio's apps updated at once. The result says
   * what happened, in words for the agent.
   */
  async addApp(
    input: { name: string; url: string; why: string },
    signal: AbortSignal,
  ): Promise<{ added: string } | { error: string }> {
    const { config, project } = { config: this.options.config, project: this.project }
    // What needs no network first (never a fetch for a call refused anyway).
    if (this.#appAsks >= MAX_APP_ASKS) {
      return {
        error: "no more add_app this session: go on with the project's apps, or ask the user",
      }
    }
    if (appOf(config, input.name) !== undefined) {
      return { error: `there is already an app named "${input.name}": pick another name` }
    }
    const typed = WebApp.shape.url.safeParse(input.url)
    if (!typed.success) {
      return {
        error: `url: ${typed.error.issues[0]?.message ?? "not an address"} (http(s), no credentials)`,
      }
    }
    const declined = (url: string) => this.#declined.some((d) => sameApp(url, d) || sameApp(d, url))
    if (declined(typed.data)) {
      return { error: `the user declined that site for this project: go on without it` }
    }
    const resolved = (await this.options.resolveAddress?.(typed.data)) ?? typed.data
    const card = appCard(input.name, resolved, input.why)
    if ("error" in card) return card
    if (declined(card.url)) {
      return { error: `the user declined ${card.host} for this project: go on without it` }
    }
    const same = Object.entries(webAppsOf(config.apps)).find(
      ([, app]) => sameApp(card.url, app.url) || sameApp(app.url, card.url),
    )
    if (same !== undefined) {
      return {
        error: `${card.host} is already the app "${same[0]}": use \`goto { app: ${same[0]} }\``,
      }
    }
    // The project as it would be saved: checked now (the apps' cap, one per site…), before asking.
    // At the first app's size: the size the live page grounds at (B3).
    const next = Project.safeParse({
      ...project.project,
      apps: {
        ...project.project.apps,
        [card.name]: {
          kind: "web",
          url: card.url,
          viewport: (this.#start ?? firstApp(config).app).viewport,
        },
      },
    })
    if (!next.success) {
      return { error: `can't add it: ${formatIssue(next.error.issues[0])}` }
    }
    // project.json changed on disk meanwhile: said before asking (an Allow would fail to save).
    if (projectChangedOnDisk(project)) {
      return {
        error: "project.json changed on disk: the user can reopen the project, then ask again",
      }
    }
    this.#appAsks++
    // A site added before (then removed, or in another project): its saved secrets come with it.
    const secrets = this.options.secrets?.(new URL(card.url).origin).length
    // A name scenes already use (an app removed, then added again): said, they'll open this site.
    const usedBy = scenesNaming(project, card.name)
    const allowed =
      (await this.options.requestUser(
        { kind: "approve-app", ...card, usedBy, ...(secrets !== undefined && { secrets }) },
        signal,
      )) === true
    if (!allowed) {
      this.#declined.push(card.url)
      return { error: `the user declined adding ${card.host}: go on without it` }
    }
    try {
      saveProject(project, next.data)
    } catch (error) {
      return {
        error: `allowed, but not saved: ${error instanceof Error ? error.message : String(error)} (the user can reopen the project)`,
      }
    }
    // The studio's apps at once (the live page, the replay, the recording): the rest as it was.
    this.options.config = { ...config, apps: project.project.apps }
    return { added: card.name }
  }

  /**
   * The project's apps changed outside the studio (the user removed one): its config takes them
   * (the live page, the replay, the recording), and a scene's start app no longer listed is dropped.
   */
  setApps(apps: ProjectConfig["apps"]): void {
    this.options.config = { ...this.options.config, apps }
    // The page may be on the removed site: its refs are never used (the agent looks again).
    this.#snapshot = undefined
    this.#checked = undefined
    for (const [scene, app] of this.#sceneApps) {
      if (appOf(this.options.config, app) === undefined) this.#sceneApps.delete(scene)
    }
  }

  /** A scene saved with its start app: its next steps mean that one. */
  saved(scene: string, app: string): void {
    this.#sceneApps.set(scene, app)
  }

  /** A step's result; one that ran keeps its start app for the scene's next steps. */
  #ran(scene: string, app: string, result: StepResult): StepResult {
    if (result.ok) this.#sceneApps.set(scene, app)
    return result
  }

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

  /** A saved sign-in that expired: forgotten (the next run signs in fresh). */
  #forgetExpired(error: unknown): void {
    if (error instanceof StepError && error.reason === "session-expired") this.#session = undefined
  }

  /** A session preset's key: its name, its steps and the project's apps as they are now. */
  #presetKey(name: string): string {
    const { presets, apps } = this.options.config
    return JSON.stringify([name, presets[name], apps])
  }

  /**
   * A check's or a recording's sign-in: the saved state when every session preset it uses is
   * there, unchanged (their landings in their place); else none (each signs in, then saved).
   */
  #reuse(scenario: Scenario): {
    storageState?: StorageState
    skipSessionPresets: string[]
    sessionLandings: Record<string, SessionLanding>
  } {
    const uses = sessionPresetsOf(scenario, this.options.config)
    const session = this.#session
    const held =
      session !== undefined &&
      uses.length > 0 &&
      uses.every((p) => session.presets.get(p)?.key === this.#presetKey(p))
    if (!held) return { skipSessionPresets: [], sessionLandings: {} }
    return {
      storageState: session.state,
      skipSessionPresets: uses,
      sessionLandings: Object.fromEntries(uses.map((p) => [p, session.presets.get(p)!.landing])),
    }
  }

  /**
   * Saves the sign-in when a session preset is done (signed in fresh) or held (a reuse's checks
   * passed: its state renewed, a refresh token it spent). A fresh run's state replaces the whole
   * (other presets sign in again); a snapshot that fails is never saved, never a failure.
   */
  #sessionHooks() {
    let first = true
    return async (preset: string, page: Page, held: boolean) => {
      let state: StorageState
      try {
        state = await page.context().storageState({ indexedDB: true })
      } catch {
        return
      }
      const session = this.#session
      // Held (a reuse's checks passed): the state renewed, the landings as they were.
      if (held) {
        if (session !== undefined) this.#session = { state, presets: session.presets }
        return
      }
      const landing = landingOf(this.options.config, page)
      if (landing === undefined) return
      // A fresh sign-in: its run's state replaces the whole (others sign in again next time).
      const presets: SessionPresets =
        first || session === undefined ? (new Map() as SessionPresets) : session.presets
      first = false
      presets.set(preset, { key: this.#presetKey(preset), landing })
      this.#session = { state, presets }
    }
  }

  /**
   * Saves a preset the agent wrote (a sign-in, its handover included): a new name only (never one
   * that exists: scenes and approvals would follow another); a session preset ends with a check of
   * the signed-in page (`waitFor`/`expect`: how a reuse knows it still holds).
   */
  savePreset(input: {
    name: string
    session: boolean
    app?: string
    steps: unknown
  }): { saved: string } | { error: string } {
    const { project } = this
    if (Object.hasOwn(project.project.presets ?? {}, input.name)) {
      return { error: `a preset named "${input.name}" exists: pick another name` }
    }
    const preset = Preset.safeParse({
      ...(input.app !== undefined && { app: input.app }),
      session: input.session,
      steps: input.steps,
    })
    if (!preset.success) return { error: `invalid preset: ${formatIssue(preset.error.issues[0])}` }
    if (preset.data.session && !checksSignedIn(preset.data.steps)) {
      return {
        error:
          "a session preset ends with a waitFor or an expect of something the signed-in page shows (visible, text: how a reuse knows the session still holds)",
      }
    }
    const next = Project.safeParse({
      ...project.project,
      presets: { ...project.project.presets, [input.name]: preset.data },
    })
    if (!next.success) return { error: `can't save it: ${formatIssue(next.error.issues[0])}` }
    if (projectChangedOnDisk(project)) {
      return {
        error: "project.json changed on disk: the user can reopen the project, then save again",
      }
    }
    try {
      saveProject(project, next.data)
    } catch (error) {
      return { error: `not saved: ${error instanceof Error ? error.message : String(error)}` }
    }
    this.options.config = {
      ...this.options.config,
      presets: { ...this.options.config.presets, [input.name]: preset.data },
    }
    return { saved: input.name }
  }

  /**
   * A fresh browser as the recording films a scene: the viewport and pixel ratio of the app it
   * starts in (one size per take).
   */
  #filmed(scenario: Scenario): Filmed {
    const { viewport } = startAppOf(scenario, this.options.config).app
    return {
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
    }
  }

  /**
   * A scrubber for text the agent reads: never a known secret value in it (the host's, and the live
   * page's, as they are now). Built once for a whole result (the tools' boundary).
   */
  scrubber(): (text: string) => string {
    return secretScrubber(this.#knownValues())
  }

  /** Every secret value known now: the host's, and the live page's. */
  #knownValues(): Set<string> {
    const values = new Set([...(this.options.knownValues?.() ?? []), ...this.#typed])
    if (this.#live !== undefined) for (const v of knownValuesOf(this.#live.context)) values.add(v)
    return values
  }

  /** Refused when the model takes no images (said with its reason); else nothing. */
  async refusedImages(): Promise<{ error: string } | undefined> {
    if ((await this.options.seesImages?.()) ?? true) return undefined
    return { error: "the model doesn't take images: you can't see one" }
  }

  /**
   * An image file for the model: its pixels made again (never its bytes: no metadata; a file that
   * isn't an image refused), at most 2,000 px on its long side; refused when the model takes none.
   */
  async imageForModel(
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<FittedImage | { error: string }> {
    const refused = await this.refusedImages()
    if (refused !== undefined) return refused
    try {
      return await fitImage(this.options.browser, bytes, signal)
    } catch (error) {
      if (error instanceof ImageRefusal) return { error: error.message }
      // A stop is a stop; anything else (the renderer crashed, the browser went away): refused.
      if (signal?.aborted === true) throw error
      return { error: "it couldn't be decoded (the browser failed): try again" }
    }
  }

  /**
   * The live page as an image (the agent's `look`): the viewport, or one element of the last
   * snapshot (`ref`: the image is its box, so an `at` fraction on it is a position in the image).
   * Every place a secret value may show is painted over first (`maskedScreenshot`); no image
   * rather than an unchecked one.
   */
  async look(
    ref?: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; image: string } | { error: string }> {
    const page = await this.livePage()
    // A ref's box, measured in both scans around the capture (it must not move); the image is its
    // part on screen (an `at` fraction maps onto the image only when it's whole). Never scrolled
    // to: a look changes nothing on the page (a replay would never see that scroll).
    let measure: (() => Promise<Box | null>) | undefined
    let whole: Box | undefined
    if (ref !== undefined) {
      const refused = this.#refusedNow([{ path: [], ref, extra: [] }])
      if (refused !== undefined) return { error: refused }
      // A ref holds only in the document it was given in (a new one may number another element so).
      const doc = await documentOf(page)
      if (doc === undefined || doc !== this.#snapshot?.doc) {
        return {
          error: `ref ${ref}: the page loaded a new document since the snapshot: take a new snapshot`,
        }
      }
      const target = page.locator(`aria-ref=${ref}`)
      if ((await target.boundingBox({ timeout: 2000 }).catch(() => null)) === null) {
        return { error: `ref ${ref}: it isn't on the page anymore: take a new snapshot` }
      }
      measure = async () => {
        const box = await target.boundingBox({ timeout: 2000 }).catch(() => null)
        // Read from the page when the context sets none (a desktop app's window).
        const view = await viewportOf(page).catch(() => null)
        if (box === null || view === null) return null
        whole = box
        const x1 = Math.max(0, box.x)
        const y1 = Math.max(0, box.y)
        const x2 = Math.min(view.width, box.x + box.width)
        const y2 = Math.min(view.height, box.y + box.height)
        return x2 <= x1 || y2 <= y1 ? null : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
      }
    }
    try {
      const shot = await maskedScreenshot(page, this.#knownValues(), {
        selectors: this.options.config.redaction.selectors,
        ...(measure !== undefined && { measure }),
        ...(signal !== undefined && { signal }),
      })
      let what = `the viewport, ${shot.width}×${shot.height}`
      if (whole !== undefined) {
        const box = whole
        const range = (from: number, size: number, total: number) =>
          `${(Math.max(0, -from) / size).toFixed(2)}–${(Math.min(size, total - from) / size).toFixed(2)}`
        const view = await viewportOf(page).catch(() => ({
          width: shot.width,
          height: shot.height,
        }))
        const all = shot.width >= Math.floor(box.width) && shot.height >= Math.floor(box.height)
        what = all
          ? `ref ${ref}, ${Math.round(box.width)}×${Math.round(box.height)}: an \`at\` fraction on it is a position in this image`
          : `ref ${ref}, only its part on screen: this image shows x ${range(box.x, box.width, view.width)} and y ${range(box.y, box.height, view.height)} of it (an \`at\` fraction is of the whole element)`
      }
      const masked = shot.masked > 0.5 ? " Most of it is masked (it shows secrets)." : ""
      return {
        text: `The live page (url: ${this.#where(page.url())}), ${what}.${masked}`,
        image: `data:image/png;base64,${shot.png.toString("base64")}`,
      }
    } catch (error) {
      // Stopped: thrown as such (the loop says aborted, never "try again").
      if (signal?.aborted === true) throw error
      // Said when it's how the look was asked (it won't change); else never why (a retry's reason
      // could tell what changed on the page).
      if (error instanceof LookRefusal) return { error: `couldn't look: ${error.message}` }
      return { error: "couldn't look at the page now: try again in a moment" }
    }
  }

  /**
   * The user takes the live browser for a moment (`hand_over`): a code, a CAPTCHA, what the agent
   * can't or shouldn't do. The agent sees nothing meanwhile (the tool runs alone: no snapshot, no
   * look); the host makes its live view take the user's input, and adds what they type to the
   * context's known values (scrubbed from then on). A page the user opens (a popup) becomes the
   * live page; its closing goes back. What the agent learns: done or not, the user's note, where
   * the page is now; its refs are gone (it snapshots again).
   */
  async handOver(
    task: string,
    doneWhen: string | undefined,
    signal: AbortSignal,
  ): Promise<
    | { outcome: "done" | "declined"; note?: string; url: string; title: string; took_s: number }
    | { error: string }
  > {
    await this.livePage()
    const live = this.#live
    if (live === undefined) return { error: "there's no live page to hand over" }
    const started = Date.now()
    let answer: UserAnswer
    try {
      answer = await this.#handOver(
        { task, doneWhen, where: "live" },
        live.context,
        () => live.page,
        (page) => {
          live.page = page
        },
        signal,
      )
    } finally {
      // Its refs are gone, stopped too (the page may be another): a new snapshot gives new ones.
      this.#snapshot = undefined
      this.#checked = undefined
    }
    // Never a new page here: a new context would forget what the user typed (made known on this one).
    const now = this.currentPage ?? this.#backPage()
    const title = (await now?.title().catch(() => "")) ?? ""
    const handed = typeof answer === "object" ? answer : undefined
    const note = handed?.note.trim() ?? ""
    return {
      outcome: handed?.outcome ?? "declined",
      ...(note !== "" && { note }),
      url: now === undefined ? "" : this.#where(now.url()),
      title,
      took_s: Math.round((Date.now() - started) / 1000),
    }
  }

  /** The host's handovers settled, at most a few seconds (a closing context never waits for good). */
  async #settled(): Promise<void> {
    const settled = this.options.handoversSettled?.()
    if (settled === undefined) return
    await Promise.race([settled, new Promise((r) => setTimeout(r, SETTLE_HANDOVER_MS))])
  }

  /** The page handed over to the user in a check or a recording (the live view follows it), if any. */
  get handoverPage(): Page | undefined {
    const page = this.#handoverPage
    return page !== undefined && !page.isClosed() ? page : undefined
  }

  /**
   * The user takes a page for a moment (the tool's, on the live app; a step's, on its run's): the
   * card says what and where (the page's own origin beside the agent's words). A page the user
   * opens there becomes the one handed over (the live view follows it); closed, back. Only during
   * the handover (its handlers go with it).
   */
  async #handOver(
    ask: {
      task: string
      doneWhen: string | undefined
      where: "live" | "check" | "record"
      scene?: string
    },
    context: BrowserContext,
    current: () => Page,
    follow: (page: Page) => void,
    signal: AbortSignal,
  ): Promise<UserAnswer> {
    const page = current()
    let origin = ""
    try {
      // An opaque origin (about:blank, data:) is "null": said as none.
      const own = new URL(page.url()).origin
      origin = own === "null" ? "" : own
    } catch {
      // a page with no address yet: said as none
    }
    const closers: { page: Page; back: () => void }[] = []
    const onPage = (opened: Page) => {
      const before = current()
      follow(opened)
      const back = () => {
        if (current() !== opened) return
        follow(before.isClosed() ? (latestOpen(context) ?? before) : before)
      }
      opened.once("close", back)
      closers.push({ page: opened, back })
    }
    context.on("page", onPage)
    try {
      return await this.options.requestUser(
        {
          kind: "handover",
          task: ask.task,
          ...(ask.doneWhen !== undefined &&
            ask.doneWhen.trim() !== "" && { doneWhen: ask.doneWhen }),
          origin,
          onApp: siteOf(page.url(), webAppsOf(this.options.config.apps)) === "app",
          where: ask.where,
          ...(ask.scene !== undefined && { scene: ask.scene }),
        },
        signal,
      )
    } finally {
      context.off("page", onPage)
      for (const { page: opened, back } of closers) opened.off("close", back)
    }
  }

  /**
   * What the user typed during a handover, known to the live context from now on (scrubbed from
   * every read, masked in every look), whatever page is open.
   */
  knowTyped(values: string[]): void {
    if (values.length === 0) return
    // For the studio's life (a check's or a recording's context closes; the next run must still
    // scrub and blur them), on the live context, and on the page handed over's (its run goes on).
    for (const v of values) this.#typed.add(v)
    if (this.#live !== undefined) addKnownValues(this.#live.context, values)
    const handed = this.handoverPage
    if (handed !== undefined) addKnownValues(handed.context(), values)
  }

  /** One text scrubbed (`scrubber`). */
  scrub(text: string): string {
    return this.scrubber()(text)
  }

  /**
   * A test for text the agent wrote: whether it holds a known secret's value of 4 characters or
   * more (any encoding the scrubber knows). Shorter values are scrubbed from what it reads but
   * never refuse what it writes (they'd match ordinary text: a residual, stated). Built once.
   */
  secretTest(): (text: string) => boolean {
    const values = this.#knownValues()
    const scrub = secretScrubber([...values].filter((v) => [...v].length >= MIN_CHECKED))
    return (text) => scrub(text) !== text
  }

  /** One text tested (`secretTest`). */
  holdsSecret(text: string): boolean {
    return this.secretTest()(text)
  }

  /** The project's files the agent may touch (C1's confined access), made once. */
  get files(): ProjectFiles {
    this.#files ??= new ProjectFiles(this.project.dir, {
      ...(this.options.keepVersion !== undefined && { keep: this.options.keepVersion }),
    })
    return this.#files
  }

  /** What the agent read of the project's files (`StudioOptions.fileReads`). */
  get fileReads(): Map<string, FileNote> {
    this.#fileReads ??= this.options.fileReads ?? new Map()
    return this.#fileReads
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

  /**
   * The page the agent explores and grounds on, at `app` (none: what's live, else the project's
   * first app); another app's live page is closed first (one app live at a time).
   */
  async livePage(app?: string): Promise<Page> {
    if (this.#live !== undefined && app !== undefined && this.#live.app !== app) {
      await this.#closeLive()
    }
    if (this.#live !== undefined && !this.#live.page.isClosed()) return this.#live.page
    // The page the runner followed may have closed (a popup): back on another page still open.
    const back = this.#backPage()
    if (back !== undefined) return back
    // A desktop app with no window left: it quit (launched again, said: its state is gone).
    if (this.#live?.target !== undefined) {
      this.#notice = `${this.#live.app ?? "the app"} quit: launched again fresh (what earlier steps did is gone)`
    }
    const wanted = app ?? this.#live?.app
    this.#opening ??= this.#open(wanted).finally(() => {
      this.#opening = undefined
    })
    return this.#opening
  }

  /** The live page closed whole (a desktop app's target: its process and sandbox too). */
  async #closeLive(): Promise<void> {
    const live = this.#live
    if (live === undefined) return
    // A handover on it still reading its fields: done first (what the user typed made known).
    await this.#settled()
    this.#live = undefined
    await (live.target !== undefined ? live.target.close() : live.context.close()).catch(
      () => undefined,
    )
  }

  async #open(app?: string): Promise<Page> {
    await this.#closeLive()
    // None asked: the first app (with no desktop launcher here, the first web app, as ever).
    const name =
      app ??
      (this.options.launchDesktop === undefined
        ? Object.entries(this.options.config.apps).find(([, a]) => a.kind === "web")?.[0]
        : undefined) ??
      firstApp(this.options.config).name
    const start = appOf(this.options.config, name)
    if (start === undefined) throw new Error(`"${name}" isn't one of the project's apps`)
    if (start.kind === "electron") {
      const launch = this.options.launchDesktop
      if (launch === undefined)
        throw new Error(`"${name}" is a desktop app: none can be opened here`)
      const { target } = await launch(name, this.#lifetime.signal)
      // Closed meanwhile: never kept (nothing would close it).
      if (this.#lifetime.signal.aborted) {
        await target.close().catch(() => undefined)
        throw new Error("the studio was closed")
      }
      this.#live = { context: target.context, page: target.page, app: name, target }
      return target.page
    }
    const { width, height } = start.viewport
    const context = await this.options.browser.newContext({ viewport: { width, height } })
    try {
      const page = await context.newPage()
      await page.goto(start.url)
      // Closed meanwhile: never kept (nothing would close it).
      if (this.#lifetime.signal.aborted) throw new Error("the studio was closed")
      // Kept only once it's at the app (a failed first visit is tried again next time).
      this.#live = { context, page, app: name }
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
    const back = this.#live === undefined ? undefined : latestOpen(this.#live.context)
    if (this.#live !== undefined && back !== undefined) this.#live.page = back
    return back
  }

  #where(url: string, site?: Site): string {
    // A desktop app's page: its own or not, by its guard (never its file path: the user's).
    const target = this.#live?.target
    if (target !== undefined) {
      return target.allows(url)
        ? `${this.#live?.app ?? "the app"}'s own page`
        : `${placeOf(url)} (not the app's own)`
    }
    // Named whenever the project has several apps (a desktop one too: the prompt lists them all).
    const { apps } = this.options.config
    return whereOf(url, webAppsOf(apps), site, Object.keys(apps).length > 1)
  }

  /** A note once (a desktop app launched again), then nothing. */
  #told(): string {
    const notice = this.#notice
    this.#notice = undefined
    return notice === undefined ? "" : `\nnote: ${notice}`
  }

  /** A step done, and where its page is: a page that failed to load makes it a failure. */
  #landed(url: string, said: string): StepResult {
    if (this.#live?.target !== undefined) {
      const own = this.#live.target.allows(url)
      return {
        ok: true,
        text: `${said}. url: ${this.#where(url)}${this.#told()}`,
        site: own ? "app" : "other",
      }
    }
    const site = siteOf(url, webAppsOf(this.options.config.apps))
    if (site === "unloaded") {
      return {
        ok: false,
        text: "failed (page-not-loaded): the page failed to load: try again",
        site,
      }
    }
    return { ok: true, text: `${said}. url: ${this.#where(url, site)}`, site }
  }

  /**
   * The live page's accessibility snapshot (or one region's), with its URL; with `find`, only the
   * parts that mention it (a long page's content past the cut).
   */
  async snapshot(within?: unknown, find?: string): Promise<StepResult> {
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
    // Scrubbed whole, then searched and cut: a value the cut splits would pass the scrubber in
    // part, and a search before scrubbing would tell a guess of a value from a miss.
    const scrubbed = this.scrub(text)
    const found = find === undefined ? undefined : findInSnapshot(scrubbed, find)
    const shown = found === undefined ? scrubbed : found.text
    const where = within === undefined ? "page" : "region"
    if (find !== undefined && shown === "") {
      return {
        ok: true,
        text: `url: ${this.#where(page.url())}\nnothing in the ${where} mentions ${JSON.stringify(find)}`,
      }
    }
    // Only near matches: said first (the phrase as written isn't there).
    const nearly =
      found?.near === true
        ? `\nnothing in the ${where} holds ${JSON.stringify(find)} as written; these hold all its words:`
        : ""
    const cut =
      shown.length > SNAPSHOT_MAX
        ? `${shown.slice(0, SNAPSHOT_MAX)}\n… (cut: ${shown.length} chars; ${find === undefined ? "use `find` to look for what you need further down, or `within` for a region" : "make `find` more specific"})`
        : shown
    const note =
      unusable === ""
        ? ""
        : `\n(${unusable}: its refs can't be used; snapshot again to point at them, or write locators)`
    return {
      ok: true,
      text: `url: ${this.#where(page.url())}${within === undefined ? await this.#view(page) : ""}${note}${nearly}${this.#told()}\n${cut}`,
    }
  }

  /**
   * Where the view is, said with a snapshot: it covers the whole page whatever is on screen, so
   * after a scroll it reads as if nothing moved (the agent once spent minutes on why).
   */
  async #view(page: Page): Promise<string> {
    const view = await viewOf(page).catch(() => undefined)
    if (view === undefined) return ""
    const down = !view.scrolled
      ? "at the top of the page"
      : view.percent === 0
        ? "a little way down the page"
        : `${view.percent}% down the page`
    const where = `${down}${view.heading === undefined ? "" : `, in "${view.heading}"`}`
    return `\nview: ${this.scrub(where)} (this snapshot covers the whole page, on screen or not)`
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
   * item (an action without id, `{ preset: … }`). Its refs become
   * lasting locators first, the page as it is right now, and a result that worked says the item as
   * it's written in the YAML.
   */
  async runStep(
    input: unknown,
    scene: string,
    signal: AbortSignal,
    part: ScenarioPart = "steps",
    startApp?: string,
  ): Promise<StepResult> {
    // The scene's start app: the one given, else the one its last step ran in, else its saved
    // scenario's (if the project still lists it: one removed is being reworked away), else the
    // first. A step without an app means it, as in the replay.
    const saved = this.project.scenes.get(scene)?.scenario?.app
    const app =
      startApp ??
      this.#sceneApps.get(scene) ??
      (saved !== undefined && appOf(this.options.config, saved) !== undefined
        ? saved
        : undefined) ??
      firstApp(this.options.config).name
    const starts = appOf(this.options.config, app)
    if (starts === undefined) {
      return failed(
        `start_app: "${app}" isn't one of the project's apps (${Object.keys(this.options.config.apps).join(", ")})`,
      )
    }
    if (starts.kind !== "web" && this.options.launchDesktop === undefined) {
      return failed(`start_app: "${app}" is a desktop app: none can be grounded here`)
    }
    const raw = asObject(input)
    if (isCyclic(raw))
      return failed("invalid step: a YAML alias refers to itself (or it nests too deep)")
    // Before any of its refs is looked at: it never runs anyway.
    if (typeof raw === "object" && raw !== null && "ensure" in raw) return failed(NO_CLEANUP)
    const refs = refsAt(raw)
    if (refs.length === 0) {
      this.#checked = undefined
      return this.#ran(scene, app, await this.#runItem(raw, scene, signal, part, app))
    }
    const refused = this.#refusedNow(refs)
    if (refused !== undefined) return failed(refused)
    const written = await this.#written(raw, refs, part, signal)
    if ("error" in written) return failed(written.error)
    const result = this.#ran(
      scene,
      app,
      await this.#runItem(written.value, scene, signal, part, app),
    )
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
    app: string,
  ): Promise<StepResult> {
    if (typeof raw !== "object" || raw === null) {
      return failed(
        "invalid step: expected an object like {id: open-new, action: click, target: {...}}",
      )
    }
    // Run in the part it's for: its approvals are keyed there, as the replay's will be (A1).
    const step = part === "steps" ? Step.safeParse(raw) : { success: false as const }
    // In the steps, only a preset runs as the setup (it's setup-only).
    const setupItem =
      step.success || (part === "steps" && !("preset" in raw))
        ? undefined
        : SetupItem.safeParse(raw)
    if (!step.success && setupItem?.success !== true) {
      const r = raw as Record<string, unknown>
      // An off-camera-only kind (a handover) on camera: said as such (an id would never do).
      if (part === "steps" && typeof r.action === "string" && isOffCameraOnly(r.action)) {
        return failed(`invalid step: ${OFF_CAMERA_MESSAGE}: give its part (setup)`)
      }
      if (part === "steps" && !("id" in r) && Action.safeParse(raw).success) {
        return failed("invalid step: an on-camera step needs an id (a setup action: give its part)")
      }
      // Parsed against the shape the agent meant (a union's error only says "Invalid input").
      const [what, schema] =
        "preset" in r
          ? (["preset", PresetRef] as const)
          : "id" in r && part === "steps"
            ? (["step", Step] as const)
            : (["setup action", Action] as const)
      const result = schema.safeParse(raw)
      // The issue, then the forms of the action it meant (never a guess at the field names).
      return failed(
        `invalid ${what}: ${result.success ? "?" : formatIssue(result.error.issues[0])}${shapeOf(raw)}`,
      )
    }
    // As in the scene: started in its start app (its steps without an app mean that one).
    const scenario: Scenario = {
      ...(step.success || setupItem?.data === undefined
        ? { version: 1, steps: step.success ? [step.data] : [] }
        : { version: 1, setup: [setupItem.data], steps: [] }),
      app,
    }
    let page: Page
    try {
      page = await this.livePage(app)
    } catch (error) {
      return failed(refusal(error))
    }
    try {
      await runScenario(page, scenario, this.#quick, {
        ...this.#run(scene, signal),
        ...this.#guarded(app),
        // Live: a step may go anywhere (it says where: the moment to add a site, `add_app`).
        confineToApps: false,
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
        return step.success || !("preset" in raw)
          ? this.#landed(back.url(), "ok (the page closed itself: back on the page that opened it)")
          : failed(
              `failed (page-closed): ${(error as StepError).message}; the rest of it didn't run (back on the page that opened it, url: ${this.#where(back.url())}): run its remaining steps one by one`,
            )
      }
      return failed(failure(error))
    }
  }

  /** The scenario the agent wrote, checked: parsed, against the project, its on-camera steps' count. */
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
    // Older scenes keep theirs (skipped when they run); a new one never cleans up.
    if ((scenario.teardown ?? []).length > 0 || (scenario.setup ?? []).some((i) => "ensure" in i)) {
      return { error: `invalid scenario: ${NO_CLEANUP}` }
    }
    const issues = checkScenarioAgainstProject(scenario, this.options.config)
    if (issues.length > 0) return { error: `invalid scenario: ${issues.join("; ")}` }
    // A desktop app's scene: nothing handed to the user yet (it could never be checked or filmed).
    if (
      startAppOf(scenario, this.options.config).app.kind === "electron" &&
      JSON.stringify(scenario.setup ?? []).includes('"action":"handover"')
    ) {
      return { error: `invalid scenario: ${NO_DESKTOP_HANDOVER}` }
    }
    if (scenario.steps.length < SCENE_STEPS.min || scenario.steps.length > SCENE_STEPS.max) {
      return {
        error: `a scene has ${SCENE_STEPS.min}-${SCENE_STEPS.max} on-camera steps (this one has ${scenario.steps.length})`,
      }
    }
    return { scenario }
  }

  /**
   * Replays a scenario from scratch in a fresh browser (the grounding check): "ok" or why not. As
   * the recording runs it (its pace: cursor, typing, settling; its pixel ratio): what a person's
   * pace changes in an app (a field it swaps as it's typed into, suggestions that open after a
   * pause) fails here rather than in the recording.
   */
  async replay(scenario: Scenario, scene: string, signal: AbortSignal): Promise<string> {
    let filmed: Filmed
    try {
      filmed = this.#filmed(scenario)
    } catch (error) {
      return `replay failed: ${failure(error)}`
    }
    let fresh: Fresh
    try {
      fresh = await this.#freshPage(scenario, filmed, signal)
    } catch (error) {
      if (isStopped(error)) throw error
      return `replay failed: ${refusal(error)}`
    }
    try {
      // The pointer at once, also over the scene's own pacing (its typing and settling stay).
      const paced: Scenario = {
        ...scenario,
        overrides: {
          ...scenario.overrides,
          pacing: { ...scenario.overrides?.pacing, cursor: "instant" },
        },
      }
      await runScenario(fresh.page, paced, this.options.config, {
        ...this.#run(scene, signal, "check", fresh.desktop),
        fresh: true,
        ...fresh.run,
      })
      return "ok"
    } catch (error) {
      if (isStopped(error)) throw error
      this.#forgetExpired(error)
      return `replay failed: ${failure(error)}`
    } finally {
      await this.#settled()
      await fresh.close().catch(() => undefined)
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
    let filmed: Filmed
    try {
      filmed = this.#filmed(scenario)
    } catch (error) {
      return failed(`can't record "${sceneId}": ${failure(error)}`)
    }
    let fresh: Fresh
    try {
      fresh = await this.#freshPage(scenario, filmed, signal)
    } catch (error) {
      if (isStopped(error)) throw error
      return failed(`can't record "${sceneId}": ${refusal(error)}`)
    }
    const dir = takes.newTakeDir(this.project.project.id, sceneId)
    let recorded: Awaited<ReturnType<typeof recordScenario>> | undefined
    let why: string | undefined
    let stopped: StepError | undefined
    try {
      recorded = await recordScenario(fresh.page, scenario, config, {
        ...this.#run(sceneId, signal, "record", fresh.desktop),
        fresh: true,
        ...fresh.run,
        ...(fresh.build !== undefined && { appBuild: fresh.build }),
        outDir: dir,
        // A failed take's video is dropped as it settles: never encoded.
        encodeFailed: false,
      })
    } catch (error) {
      if (isStopped(error)) stopped = error as StepError
      this.#forgetExpired(error)
      why = failure(error)
    } finally {
      await this.#settled()
      await fresh.close().catch(() => undefined)
    }
    let take: Awaited<ReturnType<TakeStore["settle"]>>
    try {
      take = await takes.settle(dir)
    } catch (error) {
      if (stopped !== undefined) throw stopped
      // The recorder's own reason first; then why the take went (encryption refused: deleted).
      return failed(
        `recording failed: ${why !== undefined ? `${why}; then ${failure(error)}` : failure(error)}`,
      )
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
    this.options.afterRecord?.()
    const { warnings } = made
    const notes = [
      ...recorded.warnings,
      ...warnings,
      ...(take.warning !== undefined ? [take.warning] : []),
    ]
    return {
      ok: true,
      text:
        `recorded (${Math.round(take.meta.durationMs / 100) / 10} s)` +
        (notes.length > 0 ? `; warnings: ${notes.join("; ")}` : ""),
    }
  }

  /**
   * A fresh page for a check or a recording, in the scene's start app: a web app's in a new context
   * (its saved sign-in reused when it holds); a desktop app's in a fresh launch (its own sandbox:
   * the same files and state every time; no saved sign-in), closed whole after.
   */
  async #freshPage(scenario: Scenario, filmed: Filmed, signal: AbortSignal): Promise<Fresh> {
    const start = startAppOf(scenario, this.options.config)
    if (start.app.kind === "electron") {
      const launch = this.options.launchDesktop
      if (launch === undefined) {
        throw new Error(`"${start.name}" is a desktop app: none can be run here`)
      }
      const { target, build } = await launch(
        start.name,
        AbortSignal.any([signal, this.#lifetime.signal]),
      )
      return {
        page: target.page,
        run: { electron: electronHook(start.name, target) },
        build,
        desktop: true,
        close: () => target.close().then(() => undefined),
      }
    }
    const reuse = this.#reuse(scenario)
    const context = await this.options.browser.newContext({
      ...filmed,
      ...(reuse.storageState !== undefined && { storageState: reuse.storageState }),
    })
    try {
      return {
        page: await context.newPage(),
        run: {
          skipSessionPresets: reuse.skipSessionPresets,
          sessionLandings: reuse.sessionLandings,
          onSessionReady: this.#sessionHooks(),
        },
        desktop: false,
        close: () => context.close(),
      }
    } catch (error) {
      await context.close().catch(() => undefined)
      throw error
    }
  }

  /** Closes the live page (the browser is the host's); every tool and dialog still running stops. */
  async close(): Promise<void> {
    this.#lifetime.abort()
    await this.#closeLive()
  }

  /** A desktop app's guard for a run in it (its live target's), when the live page is one. */
  #guarded(app: string): Pick<RunOptions, "electron"> {
    const target = this.#live?.target
    if (target === undefined || this.#live?.app !== app) return {}
    return { electron: electronHook(app, target) }
  }

  #run(
    sceneId: string,
    signal: AbortSignal,
    where: "live" | "check" | "record" = "live",
    desktop = this.#live?.target !== undefined,
  ) {
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
      knownSecretValues: [...(knownValues?.() ?? []), ...this.#typed],
      // A handover step: the user does a part themselves, on this run's page (the live view
      // follows it), never filmed.
      requestHandover: async (request: HandoverRequest) => {
        // A desktop app's window isn't handed to the user yet (measured first: PR 5).
        if (desktop) return { outcome: "declined" as const, note: NO_DESKTOP_HANDOVER }
        const context = request.page.context()
        this.#handoverPage = request.page
        const answer = await ask(signal, () =>
          this.#handOver(
            {
              task: request.task,
              doneWhen: request.doneWhen,
              where,
              ...(where !== "live" && { scene: sceneId }),
            },
            context,
            () => this.#handoverPage ?? request.page,
            (page) => {
              this.#handoverPage = page
            },
            signal,
          ),
        ).finally(() => {
          this.#handoverPage = undefined
        })
        const handed = typeof answer === "object" ? answer : undefined
        return {
          outcome: handed?.outcome ?? "declined",
          ...(handed !== undefined && handed.note.trim() !== "" && { note: handed.note }),
        }
      },
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

/** A context's latest page still open (the one a closed popup's opener most likely is). */
function latestOpen(context: BrowserContext): Page | undefined {
  return (
    context
      .pages()
      // A desktop app's DevTools: never a page the agent works on.
      .filter((p) => !p.isClosed() && !p.url().startsWith("devtools://"))
      .at(-1)
  )
}

/**
 * A dialog to the host, never opened once `signal` has aborted (a host rejecting on the abort
 * event would never hear it, and the run would wait on it).
 */
async function ask<T>(signal: AbortSignal, open: () => T | Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return open()
}

/** Why a desktop app's scene hands nothing to the user (decided 2026-10-10: measured in PR 5). */
const NO_DESKTOP_HANDOVER =
  "a desktop app's window isn't handed to the user yet (signing in by hand comes next): a desktop scene has no handover step"

/** A fresh page for a check or a recording, and how its run goes and ends. */
interface Fresh {
  page: Page
  run: Partial<RunOptions>
  build?: NonNullable<TakeMeta["appBuild"]>
  desktop: boolean
  close: () => Promise<void>
}

/** A desktop app's run hook from its launched target (its guard, its windows). */
function electronHook(app: string, target: ElectronTarget): NonNullable<RunOptions["electron"]> {
  return {
    app,
    allows: target.allows,
    stopped: target.stopped,
    prepare: target.prepare,
    quiet: target.quiet,
  }
}

/**
 * Why something couldn't start, for the agent: a refusal the user settles (a desktop app's
 * approval) says so, for the agent to tell them and never retry.
 */
function refusal(error: unknown): string {
  const why = failure(error)
  return (error as { needsUser?: unknown }).needsUser === true
    ? `${why}. The user settles this (the Apps panel): tell them, don't retry`
    : why
}

/** Why a scene never has a teardown or an `ensure` (OBJECT-MODEL §0.4). */
const NO_CLEANUP =
  "no teardown and no ensure: Kiframe doesn't clean up after a scene (what it creates stays in the app, the user is told); remove them"

/** add_app cards a session may show (asking again and again tires the user into allowing). */
const MAX_APP_ASKS = 3

const isStopped = (error: unknown) => error instanceof StepError && error.reason === "stopped"

/** The forms of the action an item meant (its `action`), for a refusal: empty if it isn't one. */
function shapeOf(raw: object): string {
  const kind = (raw as { action?: unknown }).action
  // A preset isn't an action: its own error is the whole answer.
  if ("preset" in raw) return ""
  if (typeof kind !== "string" || !Object.hasOwn(ACTION_REFERENCE, kind)) {
    return `\nactions: ${Object.keys(ACTION_REFERENCE).join(", ")}`
  }
  return `\n${actionReference(kind as ActionKind)}`
}

/**
 * Where a page is, against the project's apps (read from the URLs, never from text): one of them
 * (its origin, or its address redirected to www. or https: `sameApp`); another site; or Chromium's
 * error page (the load failed). A blob: URL is its creator's origin; data: and file: pages are
 * another site.
 */
export type Site = "app" | "other" | "unloaded"

/** The project's apps (by name), or one app's address. */
type AppsArg = string | Readonly<Record<string, { url: string }>>

function listed(apps: AppsArg): [string, URL][] {
  return typeof apps === "string"
    ? [["", new URL(apps)]]
    : Object.entries(apps).map(([name, app]) => [name, new URL(app.url)])
}

/** The listed app a page is on (its name, "" for a single address; its URL), if any. */
function appAt(page: URL, apps: AppsArg): [string, URL] | undefined {
  return listed(apps).find(([, app]) => sameApp(page, app))
}

export function siteOf(url: string, apps: AppsArg): Site {
  let page: URL
  try {
    page = new URL(url)
  } catch {
    return "other"
  }
  if (page.protocol === "chrome-error:") return "unloaded"
  // A blank page (a tab just opened, the first page before a goto): as the replay takes it. Any
  // other about: page (about:srcdoc, about:blank#blocked) isn't one of the apps there either.
  if (page.href === "about:blank") return "app"
  // A listed app's own origin, or its address redirected to www. or https (`sameApp`).
  return appAt(page, apps) !== undefined ? "app" : "other"
}

/** A fresh browser's size as a scene is filmed (its start app's viewport and pixel ratio). */
interface Filmed {
  viewport: { width: number; height: number }
  deviceScaleFactor: number
}

/** A step's outcome: ok or not, what the agent reads, and where the page is (when it was read). */
export interface StepResult {
  ok: boolean
  text: string
  site?: Site
}

/**
 * Where a page is, as the agent reads it: its path (never its query: it may hold a value), the
 * app's name when the project has several, and what its site is when it
 * isn't a listed app's own origin (`siteOf`).
 */
export function whereOf(
  url: string,
  apps: AppsArg,
  site = siteOf(url, apps),
  several = listed(apps).length > 1,
): string {
  if (site === "unloaded") return "(the page failed to load: try again)"
  let page: URL
  try {
    page = new URL(url)
  } catch {
    return "(an unreadable address: not the app)"
  }
  // A blank page (a popup not loaded yet, the first page before a goto): the app's, but empty.
  if (page.protocol === "about:") return "(a blank page)"
  const all = listed(apps)
  const on = site === "app" ? appAt(page, apps) : undefined
  if (on !== undefined) {
    const [name, app] = on
    // Several apps: always named (the agent tells "back on app" from "still on docs").
    const path = several ? `${name}: ${page.pathname}` : page.pathname
    // The app's site under another address (redirected to www. or https): its steps work, its
    // secrets don't (typed on their exact origin only): said, so a refused secret step has a why.
    return page.origin === app.origin
      ? path
      : `${path} (on ${page.origin}, the app's site: secrets are typed on ${app.origin} only)`
  }
  if (page.origin === "null") return `(a ${page.protocol.replace(":", "")} page: not the app)`
  const shown = new URL(page.origin)
  return all.length === 1
    ? `${page.pathname} (on ${shown.host}: NOT the app's site, ${all[0]?.[1].host ?? ""})`
    : `${page.pathname} (on ${shown.host}: NOT one of the project's apps, ${all.map(([, a]) => a.host).join(", ")})`
}

/** Where in a scenario an item runs. */
export type ScenarioPart = "setup" | "steps"

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
  const schema = part === "steps" && "id" in r ? Step : SetupItem
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
