import { execFile, spawn, type ChildProcess } from "node:child_process"
import { posix } from "node:path"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { readdir, readlink, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import { sameApp, type Viewport } from "@kiframe/schema"
import { untilStopped } from "./look.ts"
import {
  chromium,
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

/** Shutdown phases that took long, said on stderr (KIFRAME_ELECTRON_TIMING): CI's evidence. */
function timing(phase: string, since: number) {
  const took = Date.now() - since
  if (process.env.KIFRAME_ELECTRON_TIMING !== undefined && took > 500) {
    process.stderr.write(`[electron] ${phase} took ${took} ms\n`)
  }
}

const QUIT_EARLY =
  "the app quit before Kiframe could attach (it may allow only one instance: quit it and try again; be a launcher for another program; or refuse automation)"

/** An app that couldn't be launched or attached: said to the user as is. */
export class ElectronLaunchError extends Error {}

export interface ElectronLaunch {
  /** The app's executable (`X.app/Contents/MacOS/X`), resolved and approved by the host. */
  executable: string
  /** Its `.app` bundle: a `file:` page inside it is the app's own. */
  bundle?: string
  /** What the app opens (positional: the project's `args`). */
  args?: readonly string[]
  /** The size its windows are shown at (emulated: the window itself is never moved). */
  viewport: Pick<Viewport, "width" | "height" | "deviceScaleFactor">
  /** The https sites a wrapper app shows as its own (the project's `origins`). */
  origins?: readonly string[]
  /** A file noting the launches still running: what a crash left is swept at the next start. */
  stateFile?: string
  signal?: AbortSignal
  /**
   * How long its windows must stay as they are before its main window is chosen (default 1.5 s: a
   * splash closing, a sign-in window replaced). Tests of a plain app: shorter.
   */
  settleMs?: number
  /** Tests: how long to wait for the app, its port and its first window together (default 20 s). */
  timeoutMs?: number
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

/** A fresh sandbox: the app's HOME (and macOS's), its XDG folders, its temp and its profile. */
function makeSandbox(): { root: string; env: NodeJS.ProcessEnv; profile: string } {
  // The real path: macOS's /var is a link (a file: page's path is compared with it).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kiframe-app-")))
  const dirs = {
    home: join(root, "home"),
    config: join(root, "home", ".config"),
    data: join(root, "home", ".local", "share"),
    cache: join(root, "home", ".cache"),
    state: join(root, "home", ".local", "state"),
    tmp: join(root, "tmp"),
    profile: join(root, "profile"),
  }
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {}
  for (const name of PASSED_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("LC_")) env[name] = value
  }
  Object.assign(env, {
    HOME: dirs.home,
    // macOS: what reads NSHomeDirectory follows it (not appData, not the app's preferences: those
    // stay the user's, checked by the trial launch).
    CFFIXED_USER_HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    TMPDIR: `${dirs.tmp}${sep}`,
  })
  return { root, env, profile: dirs.profile }
}

/** How long the app's windows must stay as they are before its main window is chosen. */
const SETTLE_MS = 1500

/** Launches `opts.executable` in a fresh sandbox and attaches to its main window. */
export async function launchElectron(opts: ElectronLaunch): Promise<ElectronTarget> {
  opts.signal?.throwIfAborted()
  // Before anything runs: an app moved since it was approved is said, never half-launched.
  let bundles: string[]
  try {
    // As given and as it really is: an app may build its pages' paths either way.
    bundles = opts.bundle === undefined ? [] : [opts.bundle, realpathSync(opts.bundle)]
  } catch {
    throw new ElectronLaunchError(`the app isn't at ${opts.bundle ?? ""} any more`)
  }
  const deadline = Date.now() + (opts.timeoutMs ?? LAUNCH_MS)
  const sandbox = makeSandbox()
  const child = spawn(
    opts.executable,
    [...(opts.args ?? []), `--user-data-dir=${sandbox.profile}`, "--remote-debugging-port=0"],
    // Its own process group (killed whole), no terminal; its output read for the port only.
    { detached: true, env: sandbox.env, stdio: ["ignore", "ignore", "pipe"], cwd: sandbox.root },
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
      const ended = await stop(child, sandbox.root, opts.stateFile, alive)
      const t0 = Date.now()
      await within(
        browser?.close().catch(() => undefined),
        CLOSE_MS,
      )
      timing("close", t0)
      return ended
    })())
  try {
    // Noted at once (a crash from here on is swept at the next start); a note that can't be
    // written ends the launch (never an app left running unnoted).
    note(opts.stateFile, sandbox.root, true)
    const endpoint = await debuggingEndpoint(
      child,
      sandbox.profile,
      deadline,
      opts.signal,
      () => spawnError,
    )
    browser = await untilStopped(
      chromium.connectOverCDP(endpoint, { timeout: Math.max(1, deadline - Date.now()) }),
      opts.signal,
    )
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
    // Sealed now, from the main window alone: its own scheme (app:) or dev server (loopback).
    const launched = new Set<string>()
    const schemes = new Set<string>()
    const embedded = new Set<string>()
    const origin = loopbackOrigin(page.url())
    if (origin !== undefined) launched.add(origin)
    const scheme = ownScheme(page.url())
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
      sandbox: sandbox.root,
      launched,
      schemes,
      origins: [...(opts.origins ?? []), ...embedded],
    }
    const allows = (url: string) => allowedPage(url, own)
    if (!allows(page.url())) {
      throw new ElectronLaunchError(
        `the app shows ${placeOf(page.url())}: if that's the app's own, list it in its origins`,
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
              : p.goBack().then((back) => (back === null ? frame.goto("about:blank") : back))
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
    if (opts.signal?.aborted === true) throw opts.signal.reason as Error
    if (spawnError !== undefined) {
      throw new ElectronLaunchError(`the app couldn't be launched (${spawnError.message})`)
    }
    if (quit && !(error instanceof ElectronLaunchError)) throw new ElectronLaunchError(QUIT_EARLY)
    throw error
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
    const exited = () => finish(new ElectronLaunchError(QUIT_EARLY))
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
    if (gone()) throw new ElectronLaunchError(QUIT_EARLY)
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
    sandbox: string
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
    return own.bundles.some(inside) || inside(own.sandbox)
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
  stateFile: string | undefined,
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
  const swept = await sweepSandbox(sandbox)
  timing("sweep", t0)
  t0 = Date.now()
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
    () => undefined,
  )
  timing("remove", t0)
  try {
    note(stateFile, sandbox, false)
  } catch {
    // kept: swept at the next start
  }
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

/** A command's output (empty when it fails: said by the caller's next check). */
function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      // lsof exits 1 when nothing matches: its output (empty) is still the answer.
      resolve(error !== null && (error as { code?: unknown }).code !== 1 ? undefined : stdout)
    })
  })
}

/**
 * Every process's working folder: Linux's /proc (quick), else `lsof` (macOS: no /proc); undefined
 * when it can't be read.
 */
async function workingDirs(): Promise<[number, string][] | undefined> {
  if (process.platform === "linux") {
    const out: [number, string][] = []
    try {
      for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue
        try {
          out.push([Number(entry), await readlink(`/proc/${entry}/cwd`)])
        } catch {
          // gone, or another user's
        }
      }
      return out
    } catch {
      return undefined
    }
  }
  const listed = await run("lsof", ["-a", "-d", "cwd", "-Fpn"])
  if (listed === undefined) return undefined
  const out: [number, string][] = []
  let pid: number | undefined
  for (const line of listed.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid !== undefined) out.push([pid, line.slice(1)])
  }
  return out
}

/**
 * Kills every process (never this one) that points at `sandbox`: its command line names it (the
 * app's helpers carry `--user-data-dir=<sandbox>/profile`), or it works in it (a helper detached
 * with its cwd there). Both are quick to read (never a walk of every file). Unread: said.
 */
export async function sweepSandbox(sandbox: string): Promise<{ swept: number; unread: boolean }> {
  if (!existsSync(sandbox)) return { swept: 0, unread: false }
  const [ps, cwds] = await Promise.all([run("ps", ["-axo", "pid=,command="]), workingDirs()])
  const pids = new Set<number>()
  const within = (path: string) => path === sandbox || path.startsWith(`${sandbox}/`)
  for (const line of ps?.split("\n") ?? []) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match !== null && match[2]?.includes(sandbox) === true) pids.add(Number(match[1]))
  }
  for (const [pid, cwd] of cwds ?? []) if (within(cwd)) pids.add(pid)
  pids.delete(process.pid)
  for (const p of pids) {
    try {
      process.kill(p, "SIGKILL")
    } catch {
      // gone
    }
  }
  return { swept: pids.size, unread: ps === undefined || cwds === undefined }
}

/** Adds (or removes) a running launch's sandbox in the state file. */
function note(stateFile: string | undefined, sandbox: string, running: boolean) {
  if (stateFile === undefined) return
  const all = readState(stateFile).filter((s) => s !== sandbox)
  if (running) all.push(sandbox)
  writeFileSync(stateFile, JSON.stringify(all))
}

/** A sandbox this module made: a `kiframe-app-*` folder directly in the temp folder, nothing else. */
function isSandbox(path: string): boolean {
  try {
    const real = realpathSync(path)
    return dirname(real) === realpathSync(tmpdir()) && basename(real).startsWith("kiframe-app-")
  } catch {
    return false
  }
}

function readState(stateFile: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile, "utf8"))
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : []
  } catch {
    return []
  }
}

/**
 * What a crash left (launches still noted): every process pointing at their sandboxes killed (by
 * the sandbox, never a process id that may be another program's by now), the sandboxes removed.
 * Only folders this module makes are touched. Called at the host's start.
 */
export async function sweepElectronOrphans(stateFile: string): Promise<number> {
  const left = readState(stateFile).filter(isSandbox)
  for (const sandbox of left) {
    await sweepSandbox(sandbox)
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined,
    )
  }
  // Only what was swept: a launch noted meanwhile (a run started during the sweep) stays.
  const now = readState(stateFile).filter((s) => !left.includes(s))
  writeFileSync(stateFile, JSON.stringify(now))
  return left.length
}
