import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { posix } from "node:path"
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import { rm } from "node:fs/promises"
import { userInfo } from "node:os"
import { join, sep } from "node:path"
import { sameApp, type Viewport } from "@kiframe/schema"
import {
  ConfinementError,
  CONFINED_SWITCHES,
  argumentIn,
  checkConfinement,
  copyFiles,
  FilesError,
  SANDBOX_EXEC,
  seatbeltProfile,
} from "./electron-confine.ts"
import {
  defaultWorkDir,
  newSandbox,
  realpathOr,
  run,
  sweepProcesses,
  WorkAreaError,
} from "./electron-workarea.ts"
import { untilStopped } from "./look.ts"
import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Frame,
  type Page,
} from "playwright"

// A desktop Electron app as a run's target (OBJECT-MODEL §0.9 "Electron apps", design reviewed
// 2026-10-08): launched from its executable (found and approved by the host: never a path from a
// project) in a fresh sandbox, attached over its debugging port (`--remote-debugging-port=0`, read
// from its own output), its windows emulated at the scene's size, its whole process group killed at
// the end and anything left holding the sandbox swept.

/** Environment variables passed through to the app: never Kiframe's own (keys, NODE_OPTIONS, ELECTRON_*). */
const PASSED_ENV = [
  "PATH",
  "LANG",
  "TZ",
  "USER",
  "LOGNAME",
  "SHELL",
  // Linux: the display and session bus the app draws on (no window without them).
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
]

/** How long an app may take to open its debugging port and its first window. */
const LAUNCH_MS = 20_000
/** How long the guard's "back" may take to commit (a busy machine: never a step's timeout). */
const BACK_MS = 10_000
/** How long closing the debugging connection may take (the group is killed after it anyway). */
const CLOSE_MS = 2000
/** How long an app that dropped the attach has to tell its exit. */
const EXIT_TELL_MS = 1000

/** `work`, given at most `ms` (its result then never awaited). */
async function within(work: Promise<unknown> | undefined, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, ms)))])
  clearTimeout(timer)
}

/** Whether the app exited, or does within `ms`. */
async function exitedSoon(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", exited)
      resolve(false)
    }, ms)
    const exited = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once("exit", exited)
  })
}

/**
 * What a launch that failed says, the one rule (every failure an ElectronLaunchError with its
 * `why`, but a stop): stopped → the stop; not started → said; the app quit (whatever the attach
 * was doing) → quit; already said → as is; anything else (Playwright, CDP) → a fixed phrase (never
 * its message: it can carry the debugging endpoint or a page's address), its detail on stderr for
 * Kiframe's own debugging only (KIFRAME_ELECTRON_DEBUG).
 */
export function launchFailure(
  error: unknown,
  state: { stopped: unknown; spawnError: Error | undefined; quit: boolean },
): unknown {
  if (state.stopped !== undefined) return state.stopped
  if (state.spawnError !== undefined) {
    return new ElectronLaunchError(`the app couldn't be launched (${state.spawnError.message})`)
  }
  if (state.quit) return new ElectronLaunchError(QUIT_EARLY, { why: "quit" })
  if (error instanceof ElectronLaunchError) return error
  debug("launch", error)
  return new ElectronLaunchError(
    error instanceof errors.TimeoutError
      ? "the app didn't answer in time (it may refuse automation)"
      : "the app couldn't be driven (its debugging connection failed)",
  )
}

/** A failure's detail, for Kiframe's own debugging: stderr, only when asked (never a tool's). */
function debug(phase: string, error: unknown) {
  if (process.env.KIFRAME_ELECTRON_DEBUG !== undefined) {
    process.stderr.write(
      `[electron] ${phase}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
  }
}

/** Shutdown phases that took long, said on stderr (KIFRAME_ELECTRON_TIMING): CI's evidence. */
function timing(phase: string, since: number) {
  const took = Date.now() - since
  if (process.env.KIFRAME_ELECTRON_TIMING !== undefined && took > 500) {
    process.stderr.write(`[electron] ${phase} took ${took} ms\n`)
  }
}

const QUIT_EARLY =
  "the app quit before Kiframe could attach (it may allow only one instance: quit it and try again; be a launcher for another program; or refuse automation)"

/**
 * An app that couldn't be launched or attached: said to the user as is. `why` read structurally (a
 * trial's outcome): it quit at once, its main window showed a site (`site`: the https origin it
 * showed or failed to load: a wrapper's own, to allow), or anything else.
 */
export class ElectronLaunchError extends Error {
  readonly why: "quit" | "site" | "other"
  readonly site: string | undefined
  constructor(
    message: string,
    detail: { why: "quit" | "other" } | { why: "site"; site: string } = { why: "other" },
  ) {
    super(message)
    this.why = detail.why
    this.site = detail.why === "site" ? detail.site : undefined
  }
}

export interface ElectronLaunch {
  /** The app's executable (`X.app/Contents/MacOS/X`), resolved and approved by the host. */
  executable: string
  /** Its `.app` bundle: a `file:` page inside it is the app's own. */
  bundle?: string
  /** What the app opens: paths in the project's files/ (`files/demo-vault`), given as the copy's. */
  args?: readonly string[]
  /** The project's files/ folder: copied into the sandbox at each launch (what `args` name). */
  files?: string
  /** Kiframe's work area (default `~/.kiframe`): the launches' sandboxes. */
  workDir?: string
  /** The size its windows are shown at (emulated: the window itself is never moved). */
  viewport: Pick<Viewport, "width" | "height" | "deviceScaleFactor">
  /** The https sites a wrapper app shows as its own (the project's `origins`). */
  origins?: readonly string[]
  signal?: AbortSignal
  /**
   * How long its windows must stay as they are before its main window is chosen (default 1.5 s: a
   * splash closing, a sign-in window replaced). Tests of a plain app: shorter.
   */
  settleMs?: number
  /** Tests: how long to wait for the app, its port and its first window together (default 20 s). */
  timeoutMs?: number
}

/** Tests only (never the package's: its launches take none of these). */
export interface LaunchHooks {
  /**
   * Arguments given as they are, before `args` (the fixture app's folder, its modes): never a
   * project's (those name files/ only).
   */
  appArgs?: readonly string[]
  /** More it may read (the repo's Electron). */
  readable?: readonly string[]
  /** Off macOS only (Linux CI): launched without the Seatbelt confinement (there's none). */
  allowUnconfined?: boolean
}

/** How long one attach may take before it's tried again. */
const ATTACH_TRY_MS = 5000

/**
 * Attached over CDP, tried again while time is left: an attach as the app's first page turns into
 * Chromium's error page (a dev server not started) can hang (measured: 1 in 5), a second never did.
 */
export async function attach(
  endpoint: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<Browser> {
  for (;;) {
    const left = deadline - Date.now()
    try {
      return await untilStopped(
        chromium.connectOverCDP(endpoint, { timeout: Math.max(1, Math.min(left, ATTACH_TRY_MS)) }),
        signal,
      )
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error
      // Out of time: said as the launch's own (never Playwright's call log, its endpoint).
      if (left <= ATTACH_TRY_MS) {
        throw new ElectronLaunchError("the app didn't answer in time (it may refuse automation)")
      }
    }
  }
}

/** Where a page that failed to load was going (Chromium's error page keeps it, over CDP). */
async function unreachableUrl(page: Page): Promise<string | undefined> {
  try {
    const cdp = await page.context().newCDPSession(page)
    try {
      const { frameTree } = await cdp.send("Page.getFrameTree")
      return frameTree.frame.unreachableUrl
    } finally {
      await cdp.detach().catch(() => undefined)
    }
  } catch {
    return undefined
  }
}

/** A page the guard stopped: in which window, whether it was the window itself, and where. */
export interface GuardStop {
  page: Page
  /** The window's own page (sent back or closed), not a frame inside it. */
  window: boolean
  place: string
}

/** A launched app: its browser connection, its context and main window, and how to end it. */
export interface ElectronTarget {
  browser: Browser
  context: BrowserContext
  page: Page
  /** The sandbox folder (its HOME, its data). */
  sandbox: string
  /** Whether a page's address is the app's own (sealed at launch: nothing a run does adds to it). */
  allows: (url: string) => boolean
  /**
   * Where the app went that isn't its own since the last call (each stopped at once: the frame
   * blanked, the window sent back or closed), said by place (never a full address: it may hold a
   * token).
   */
  stopped: () => GuardStop[]
  /** A window the run follows, at the scene's size first (its emulation applied). */
  prepare: (page: Page) => Promise<void>
  /** Resolves once the guard's stops are done (a window sent back, a frame blanked). */
  quiet: () => Promise<void>
  /**
   * Ends it (once: a second call does nothing): disconnects, kills the app's process group and
   * what still points at the sandbox, removes it. `unread`: what holds the sandbox couldn't be read.
   */
  close: () => Promise<{ unread: boolean }>
}

/** Its own process group (killed whole), no terminal; its output read for the port only. */
function spawnOptions(sandbox: { root: string; env: NodeJS.ProcessEnv }): SpawnOptions {
  return {
    detached: true,
    env: sandbox.env,
    stdio: ["ignore", "ignore", "pipe"],
    cwd: sandbox.root,
  }
}

/**
 * A fresh sandbox in the work area: the app's HOME (and macOS's), XDG, temp, profile, files. One
 * that can't be made is said (and nothing of it kept).
 */
async function makeSandbox(work: string): Promise<{
  root: string
  env: NodeJS.ProcessEnv
  profile: string
  home: string
  tmp: string
  files: string
}> {
  let root: string
  try {
    root = await newSandbox(work)
  } catch (error) {
    if (error instanceof WorkAreaError) throw new ElectronLaunchError(error.message)
    throw new ElectronLaunchError(`Kiframe's work area can't be used (${String(error)})`)
  }
  const dirs = {
    home: join(root, "home"),
    config: join(root, "home", ".config"),
    data: join(root, "home", ".local", "share"),
    cache: join(root, "home", ".cache"),
    state: join(root, "home", ".local", "state"),
    tmp: join(root, "tmp"),
    profile: join(root, "profile"),
  }
  try {
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw new ElectronLaunchError(`the app's sandbox can't be made (${String(error)})`)
  }
  const env: NodeJS.ProcessEnv = {}
  for (const name of PASSED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("LC_")) env[name] = value
  }
  Object.assign(env, {
    HOME: dirs.home,
    // macOS: what reads NSHomeDirectory follows it (not appData, not the app's preferences: those
    // stay the user's, out of reach under the confinement).
    CFFIXED_USER_HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    TMPDIR: `${dirs.tmp}${sep}`,
    // Chromium on macOS: its temp folder (the single-instance lock's socket) in the sandbox too,
    // never the user's /var/folders (denied by the confinement: such an app would quit).
    MAC_CHROMIUM_TMPDIR: dirs.tmp,
  })
  return {
    root,
    env,
    profile: dirs.profile,
    home: dirs.home,
    tmp: dirs.tmp,
    files: join(root, "files"),
  }
}

/** How long the app's windows must stay as they are before its main window is chosen. */
const SETTLE_MS = 1500

/** Launches `opts.executable` in a fresh sandbox, confined, and attaches to its main window. */
export function launchElectron(opts: ElectronLaunch): Promise<ElectronTarget> {
  return launchElectronWith(opts, {})
}

/** `launchElectron` with the tests' hooks (not exported by the package). */
export async function launchElectronWith(
  opts: ElectronLaunch,
  hooks: LaunchHooks,
): Promise<ElectronTarget> {
  opts.signal?.throwIfAborted()
  // Before anything runs: an app moved since it was approved is said, never half-launched.
  let bundles: string[]
  try {
    // As given and as it really is: an app may build its pages' paths either way.
    bundles = opts.bundle === undefined ? [] : [opts.bundle, realpathSync(opts.bundle)]
  } catch {
    throw new ElectronLaunchError(`the app isn't at ${opts.bundle ?? ""} any more`)
  }
  // The executable there and runnable (under Seatbelt the spawned program is sandbox-exec: a
  // missing app would otherwise read as one that quit).
  try {
    accessSync(opts.executable, constants.X_OK)
  } catch {
    throw new ElectronLaunchError(`the app couldn't be launched (${opts.executable} isn't there)`)
  }
  // Never unconfined in the app: off macOS (no Seatbelt) only where asked (Linux CI).
  const confined = process.platform === "darwin"
  if (!confined && hooks.allowUnconfined !== true) {
    throw new ElectronLaunchError("desktop apps run only on macOS (they're confined there)")
  }
  const work = opts.workDir ?? defaultWorkDir()
  const sandbox = await makeSandbox(work)
  // Its files and its confinement ready before it starts (said, its sandbox removed, if not).
  let args: string[]
  let profile: string | undefined
  try {
    // The confinement first (cheap): a broken one never costs the files' copy.
    if (confined) {
      const confinement = {
        sandbox: sandbox.root,
        readable: [...bundles.map(realpathOr), ...(hooks.readable ?? []).map(realpathOr)],
        // The home and the work area wherever they are, and the one temp folder left (/var/tmp).
        private: [realpathOr(userInfo().homedir), realpathOr(work), "/private/var/tmp"],
      }
      // Its own canary, beside its sandbox (never inside: that's readable) and named after it:
      // launches at once never touch each other's, and a crash's is swept with its sandbox.
      await checkConfinement(confinement, `${sandbox.root}.canary`, opts.signal)
      profile = seatbeltProfile(confinement)
    }
    if (opts.files !== undefined) await copyFiles(opts.files, sandbox.files, opts.signal)
    args = (opts.args ?? []).map((a) => argumentIn(a, sandbox.files))
    for (const arg of args) {
      if (!existsSync(arg)) {
        throw new ElectronLaunchError(`${arg.slice(sandbox.files.length + 1)} isn't in files/`)
      }
    }
    // Stopped meanwhile: never started.
    opts.signal?.throwIfAborted()
  } catch (error) {
    await rm(sandbox.root, { recursive: true, force: true }).catch(() => undefined)
    if (opts.signal?.aborted === true) throw opts.signal.reason as Error
    if (error instanceof FilesError || error instanceof ConfinementError) {
      throw new ElectronLaunchError(error.message)
    }
    if (error instanceof ElectronLaunchError) throw error
    debug("prepare", error)
    throw new ElectronLaunchError("the app's sandbox couldn't be prepared")
  }
  // The app's own time to start (the copy and the canary never count against it).
  const deadline = Date.now() + (opts.timeoutMs ?? LAUNCH_MS)
  const launchArgs = [
    ...(hooks.appArgs ?? []),
    ...args,
    `--user-data-dir=${sandbox.profile}`,
    "--remote-debugging-port=0",
  ]
  const child =
    profile === undefined
      ? spawn(opts.executable, launchArgs, spawnOptions(sandbox))
      : // Seatbelt runs the app itself (one process: its group, its pid), Kiframe's switches last.
        spawn(
          SANDBOX_EXEC,
          ["-p", profile, opts.executable, ...launchArgs, ...CONFINED_SWITCHES],
          spawnOptions(sandbox),
        )
  // Its spawn failing is said by the launch (never an unhandled 'error' event).
  let spawnError: Error | undefined
  child.on("error", (error) => (spawnError = error))
  let browser: Browser | undefined
  let ended: Promise<{ unread: boolean }> | undefined
  // Once: the app's group is signalled only while it's known alive (its leader running, or its
  // windows still connected: a group's id is never reused while the group lives).
  const end = () =>
    (ended ??= (async () => {
      const alive = browser?.isConnected() === true
      // Killed first, the connection closed after (it drops with the app: never a close the app
      // has to answer), bounded all the same.
      const ended = await stop(child, sandbox.root, alive)
      const t0 = Date.now()
      await within(
        browser?.close().catch(() => undefined),
        CLOSE_MS,
      )
      timing("close", t0)
      return ended
    })())
  try {
    const endpoint = await debuggingEndpoint(
      child,
      sandbox.profile,
      deadline,
      opts.signal,
      () => spawnError,
    )
    browser = await attach(endpoint, deadline, opts.signal)
    const context = browser.contexts()[0]
    if (context === undefined) throw new ElectronLaunchError("the app opened no window")
    const connected = browser
    const page = await mainWindow(
      context,
      deadline,
      opts.signal,
      () => child.exitCode !== null || child.signalCode !== null || !connected.isConnected(),
      opts.settleMs ?? SETTLE_MS,
    )
    // Where the main window is, or went: a load that failed (offline, a dev server not started)
    // still names it (CDP's unreachable URL), judged and said by that.
    const failed = page.url().startsWith("chrome-error:")
    const shown = failed ? ((await unreachableUrl(page)) ?? page.url()) : page.url()
    // Sealed now, from the main window alone: its own scheme (app:) or dev server (loopback).
    const launched = new Set<string>()
    const schemes = new Set<string>()
    const embedded = new Set<string>()
    const origin = loopbackOrigin(shown)
    if (origin !== undefined) launched.add(origin)
    const scheme = ownScheme(shown)
    if (scheme !== undefined) schemes.add(scheme)
    // What the main window embeds as it opens (a video, a widget) is part of the app as shipped.
    for (const frame of page.frames()) {
      const url = URL.parse(frame.url())
      // https only (a listed site's rule: never plain http in the app's name).
      if (frame !== page.mainFrame() && url !== null && url.protocol === "https:") {
        embedded.add(url.origin)
      }
    }
    const own = {
      bundles,
      // Its home, profile and temp (its own data): never the files/ copy (a project's content).
      trusted: [sandbox.home, sandbox.profile, sandbox.tmp],
      launched,
      schemes,
      origins: [...(opts.origins ?? []), ...embedded],
    }
    const allows = (url: string) => allowedPage(url, own)
    if (!shown.startsWith("chrome-error:") && !allows(shown)) {
      const url = URL.parse(shown)
      throw new ElectronLaunchError(
        `the app shows ${placeOf(shown)}: if that's the app's own, list it in its origins`,
        url?.protocol === "https:" ? { why: "site", site: url.origin } : { why: "other" },
      )
    }
    // Its own page, never loaded: said (never a window driven on Chromium's error page).
    if (failed) {
      const where = shown.startsWith("chrome-error:") ? "its page" : placeOf(shown)
      throw new ElectronLaunchError(
        `the app couldn't load ${where} (offline? its server not running?)`,
      )
    }
    // The guard: every frame of every window, every navigation, at once; one that isn't the app's
    // own is stopped (a popup closed, any other frame blanked) and said.
    const stops: GuardStop[] = []
    const stopping = new Set<Promise<void>>()
    const frameAllowed = (frame: Frame): boolean => {
      const url = frame.url()
      if (url === "" || url === "about:blank") return true
      // An inline frame (srcdoc) is its parent's content.
      if (url === "about:srcdoc") {
        const parent = frame.parentFrame()
        return parent !== null && frameAllowed(parent)
      }
      // A load that failed (Chromium's error page): said as such by the step, never a place.
      if (url.startsWith("chrome-error:")) return true
      return allows(url)
    }
    const watch = (p: Page) => {
      const check = (frame: Frame) => {
        if (frameAllowed(frame)) return
        stops.push({ page: p, window: frame === p.mainFrame(), place: placeOf(frame.url()) })
        // A popup closed; the main window back to the app's page (else nothing could bring it
        // back: no goto in a desktop app); any other frame blanked. Kept until done: a read waits
        // for it (`quiet`), never seeing a window mid-stop.
        const action: Promise<unknown> =
          frame !== p.mainFrame()
            ? frame.goto("about:blank")
            : p !== page
              ? p.close()
              : // Committed is enough (never the page's load, nor a step's short timeout).
                p
                  .goBack({ waitUntil: "commit", timeout: BACK_MS })
                  .then((back) => (back === null ? frame.goto("about:blank") : back))
        const done = action.then(
          () => undefined,
          () => undefined,
        )
        stopping.add(done)
        void done.finally(() => stopping.delete(done))
      }
      p.on("framenavigated", check)
      for (const frame of p.frames()) check(frame)
    }
    for (const p of context.pages()) watch(p)
    context.on("page", watch)
    // Every window at the scene's size, for the whole run (an override ends with its session):
    // started as a window opens, awaited before the run follows it (`prepare`); a failed attach is
    // tried again.
    const emulated = new WeakMap<Page, Promise<void>>()
    const emulate = (p: Page): Promise<void> => {
      const known = emulated.get(p)
      if (known !== undefined) return known
      const done = (async () => {
        if (isDevtools(p.url())) return
        const session: CDPSession = await context.newCDPSession(p)
        p.once("close", () => void session.detach().catch(() => undefined))
        await session.send("Emulation.setDeviceMetricsOverride", {
          width: opts.viewport.width,
          height: opts.viewport.height,
          deviceScaleFactor: opts.viewport.deviceScaleFactor,
          mobile: false,
        })
      })()
      emulated.set(p, done)
      done.catch(() => emulated.delete(p))
      return done
    }
    await emulate(page)
    context.on("page", (p) => void emulate(p).catch(() => undefined))
    return {
      browser,
      context,
      page,
      sandbox: sandbox.root,
      allows,
      stopped: () => stops.splice(0),
      prepare: (p) => emulate(p),
      quiet: async () => {
        // A stop's own action may start another navigation (a goBack): until none is left.
        while (stopping.size > 0) await Promise.all([...stopping])
      },
      close: end,
    }
  } catch (error) {
    // It quit while being attached (after opening its port): said as such, never Playwright's.
    // A moment for its exit to be told (it may quit as the attach drops: the drop comes first).
    const quit = await exitedSoon(child, EXIT_TELL_MS)
    await end()
    throw launchFailure(error, {
      stopped: opts.signal?.aborted === true ? (opts.signal.reason as unknown) : undefined,
      spawnError,
      quit,
    })
  }
}

/** Where a page is, said without its full address (a path or query may hold a token). */
export function placeOf(url: string): string {
  const parsed = URL.parse(url)
  if (parsed === null) return "an unreadable address"
  if (parsed.protocol === "file:") return "a file on this computer"
  return parsed.host === "" ? `a ${parsed.protocol} page` : parsed.host
}

/** The app's debugging endpoint, read whole: from its output's line, else its profile's file. */
function debuggingEndpoint(
  child: ChildProcess,
  profile: string,
  deadline: number,
  signal: AbortSignal | undefined,
  spawnError: () => Error | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ""
    const finish = (error?: Error, endpoint?: string) => {
      clearTimeout(timer)
      clearInterval(poll)
      child.stderr?.removeAllListeners("data")
      child.removeListener("exit", exited)
      signal?.removeEventListener("abort", aborted)
      if (error !== undefined) reject(error)
      else resolve(endpoint as string)
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-8192)
      // A whole line only (a chunk may end mid-address), on this machine only.
      const found =
        /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+)\r?\n/.exec(
          output,
        )?.[1]
      if (found !== undefined) finish(undefined, found)
    })
    // The profile's own file, inside the sandbox (never one elsewhere: an app that ignores
    // --user-data-dir would write it where Kiframe never reads), read whole.
    const poll = setInterval(() => {
      const failed = spawnError()
      if (failed !== undefined) {
        finish(new ElectronLaunchError(`the app couldn't be launched (${failed.message})`))
        return
      }
      try {
        const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")
        if (
          port !== undefined &&
          /^\d+$/.test(port) &&
          path !== undefined &&
          /^\/devtools\/browser\/[0-9a-f-]+$/.test(path)
        ) {
          finish(undefined, `ws://127.0.0.1:${port}${path}`)
        }
      } catch {
        // not yet
      }
    }, 100)
    const exited = () => finish(new ElectronLaunchError(QUIT_EARLY, { why: "quit" }))
    const aborted = () => finish(signal?.reason as Error)
    child.once("exit", exited)
    signal?.addEventListener("abort", aborted, { once: true })
    const timer = setTimeout(
      () =>
        finish(
          new ElectronLaunchError(
            "the app opened no debugging port in time (it may refuse automation)",
          ),
        ),
      Math.max(0, deadline - Date.now()),
    )
  })
}

const isDevtools = (url: string) => url.startsWith("devtools://")

/**
 * The app's main window, once it settled: its windows unchanged for a moment (a splash that closed
 * is gone), the last-opened one still open, loaded (an address and its document).
 */
async function mainWindow(
  context: BrowserContext,
  deadline: number,
  signal: AbortSignal | undefined,
  gone: () => boolean,
  settleMs: number,
): Promise<Page> {
  const windows = () => context.pages().filter((p) => !isDevtools(p.url()) && !p.isClosed())
  let seen = ""
  let since = Date.now()
  for (;;) {
    signal?.throwIfAborted()
    // Quit (or dropped its port) before showing a window: said at once, never a wait to the end.
    if (gone()) throw new ElectronLaunchError(QUIT_EARLY, { why: "quit" })
    const now = windows()
    const key = now.map((p) => p.url()).join("\n")
    if (key !== seen) {
      seen = key
      since = Date.now()
    }
    const last = now.at(-1)
    const loaded = last !== undefined && last.url() !== "" && last.url() !== "about:blank"
    if (loaded && Date.now() - since >= settleMs) {
      await last
        .waitForLoadState("domcontentloaded", { timeout: Math.max(1, deadline - Date.now()) })
        .catch(() => undefined)
      if (!last.isClosed()) return last
    }
    if (Date.now() >= deadline) throw new ElectronLaunchError("the app opened no window in time")
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** A loopback http(s) page's origin (a dev server the app loads), if it is one. */
function loopbackOrigin(url: string): string | undefined {
  const parsed = URL.parse(url)
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return
  return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ? parsed.origin : undefined
}

/** The schemes Chromium itself serves (never an app's own content: another site's, the browser's). */
const BUILT_IN = new Set([
  "about:",
  "blob:",
  "chrome:",
  "chrome-error:",
  "chrome-extension:",
  "chrome-untrusted:",
  "data:",
  "devtools:",
  "file:",
  "filesystem:",
  "http:",
  "https:",
  "javascript:",
  "view-source:",
  "ws:",
  "wss:",
])

/** A page's scheme if it's an app's own (`app:`, `vscode-file:`): none of Chromium's. */
function ownScheme(url: string): string | undefined {
  const parsed = URL.parse(url)
  return parsed === null || BUILT_IN.has(parsed.protocol) ? undefined : parsed.protocol
}

/**
 * Whether a page is the app's own: a blank page; a local `file:` inside its bundle or its sandbox
 * (never the user's files); a loopback origin or an own scheme (`app:`) its windows first showed;
 * one of its sites (`origins`, as one site: `sameApp`); a blob made by one of those. Anything else
 * (another site, Chromium's own pages, a site's `filesystem:`) isn't.
 */
export function allowedPage(
  url: string,
  own: {
    bundles: readonly string[]
    /** The sandbox's folders that are the app's own data (its home, its profile). */
    trusted: readonly string[]
    launched: ReadonlySet<string>
    schemes: ReadonlySet<string>
    origins: readonly string[]
  },
): boolean {
  if (url === "about:blank") return true
  const parsed = URL.parse(url)
  if (parsed === null) return false
  if (parsed.protocol === "blob:") {
    // Made by a page of the app's: a file: page's blob (`blob:file:///<id>`) has no path to check,
    // and only the app's own file: pages run (others are refused before they could make one).
    const inner = URL.parse(parsed.pathname)
    if (inner === null) return false
    return inner.protocol === "file:" ? inner.host === "" : allowedPage(inner.href, own)
  }
  if (parsed.protocol === "file:") {
    // Local only (never a file on another host).
    if (parsed.host !== "") return false
    let path: string
    try {
      path = decodeURIComponent(parsed.pathname)
    } catch {
      return false
    }
    // Decoding can make `..` the parser left (`..%2F`): normalized before it's compared.
    path = posix.normalize(path)
    const inside = (dir: string) =>
      path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`)
    return own.bundles.some(inside) || own.trusted.some(inside)
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return (
      own.launched.has(parsed.origin) ||
      // A listed (https) site: `sameApp` one way never takes a plain-http page for it.
      own.origins.some((site) => sameApp(parsed, site))
    )
  }
  return own.schemes.has(parsed.protocol)
}

/**
 * Ends a launch: its group terminated (then killed) while it's known alive (`alive`: its windows
 * were still connected, or its leader runs: never a group id the system may have given another
 * program since), what still points at its sandbox, the sandbox.
 */
async function stop(
  child: ChildProcess,
  sandbox: string,
  alive: boolean,
): Promise<{ unread: boolean }> {
  const pid = child.pid
  const leader = child.exitCode === null && child.signalCode === null
  let t0 = Date.now()
  if (pid !== undefined && (leader || alive || (await orphanedGroup(pid)))) {
    // Killed outright, never asked to quit: its sandbox is thrown away (nothing to save), and a
    // quit can run an updater's install-on-quit over the user's real app.
    signalGroup(pid, "SIGKILL")
  }
  timing("kill", t0)
  // Helpers that left the group (a daemon, a pty host) still point at the sandbox.
  t0 = Date.now()
  const swept = await sweepProcesses(sandbox)
  timing("sweep", t0)
  t0 = Date.now()
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    () => undefined,
  )
  timing("remove", t0)
  return { unread: swept.unread }
}

/**
 * Whether `pid`'s group still has members while no process holds `pid` itself: the group of a
 * leader that died (a recycled id would be alive as that id, never "a group without its leader").
 */
async function orphanedGroup(pid: number): Promise<boolean> {
  const table = await run("ps", ["-axo", "pid=,pgid="])
  if (table === undefined) return false
  let members = 0
  for (const line of table.split("\n")) {
    const [p, g] = line.trim().split(/\s+/).map(Number)
    if (p === pid) return false
    if (g === pid) members++
  }
  return members > 0
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {
    // gone
  }
}
