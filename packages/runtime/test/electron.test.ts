import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { errors } from "playwright"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { createServer as createNetServer } from "node:net"
import { pathToFileURL } from "node:url"
import { createServer as createHttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import {
  allowedPage,
  ElectronLaunchError,
  type ElectronTarget,
  FILES_LIMITS,
  recordScenario,
  runScenario,
  StepError,
  seatbeltProfile,
  sweepWorkArea,
} from "../src/index.ts"
import { checkConfinement, copyFiles } from "../src/electron-confine.ts"
import {
  attach,
  type ElectronLaunch,
  launchFailure,
  launchElectronWith,
  type LaunchHooks,
} from "../src/electron.ts"
import { sandboxesOf } from "../src/electron-workarea.ts"

// The Electron target (OBJECT-MODEL §0.9 "Electron apps"): a fixture desktop app launched in a
// sandbox with the repo's own Electron, driven and filmed like a web page, ended whole.

const electron = createRequire(join(import.meta.dirname, "../../../apps/desktop/package.json"))(
  "electron",
) as string
const fixture = join(import.meta.dirname, "fixtures/electron-app")
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 }
/** The repo's Electron.app (the fixture runs on it): what the confined app may read besides. */
const electronApp = electron.slice(0, electron.indexOf(".app/") + 4)
/** How many sandboxes this file's work area holds (one left behind is a leak). */
const sandboxCount = () =>
  existsSync(join(work, "sandboxes")) ? readdirSync(join(work, "sandboxes")).length : 0
/** This file's work area (never the user's ~/.kiframe). */
const work = mkdtempSync(join(tmpdir(), "kiframe-el-work-"))
/** How every launch here runs: the fixture on the repo's Electron, confined on macOS. */
// The tests' launches: the hooks (the fixture's folder and modes, the repo's Electron readable,
// unconfined on Linux CI) beside a launch's own options.
const launchElectron = (opts: ElectronLaunch & LaunchHooks) => launchElectronWith(opts, opts)

const base = {
  executable: electron,
  bundle: fixture,
  readable: [electronApp],
  workDir: work,
  allowUnconfined: true,
  viewport,
}

const project = parseProjectYaml(`version: 2
apps:
  notes: { kind: electron, bundleId: com.kiframe.fixture, viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (check: () => boolean, ms = 5000) => {
  const until = Date.now() + ms
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
  return check()
}

// Another site on this machine (never the network): where the fixture's links and windows go.
let other = ""
let secure = ""
let server: Server
let secureServer: Server
beforeAll(async () => {
  // An https site on this machine too (a throwaway certificate, trusted by the fixture only).
  const certs = mkdtempSync(join(tmpdir(), "kiframe-el-cert-"))
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      join(certs, "key.pem"),
      "-out",
      join(certs, "cert.pem"),
    ],
    { stdio: "ignore" },
  )
  secureServer = createHttpsServer(
    { key: readFileSync(join(certs, "key.pem")), cert: readFileSync(join(certs, "cert.pem")) },
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" })
      res.end("<h1>A widget</h1>")
    },
  )
  await new Promise<void>((resolve) => secureServer.listen(0, "127.0.0.1", resolve))
  secure = `https://127.0.0.1:${(secureServer.address() as AddressInfo).port}/`
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<h1>Another site</h1>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  other = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => secureServer.close(() => resolve()))
})

/** A run's desktop app: the fixture's target, as the host gives it to the runner. */
const inTarget = (target: ElectronTarget) => ({
  app: "notes",
  allows: target.allows,
  stopped: target.stopped,
  prepare: target.prepare,
  quiet: target.quiet,
})

let open: ElectronTarget[] = []
const launch = async (
  extra: string[] = [],
  options: {
    workDir?: string
    files?: string
    args?: string[]
    readable?: string[]
    timeoutMs?: number
    signal?: AbortSignal
    origins?: string[]
  } = {},
) => {
  const target = await launchElectron({
    ...base,
    appArgs: [fixture, "hidden", `link=${other}`, ...extra],
    // A plain fixture settles at once; the window-shape tests keep the real wait.
    ...(!extra.some((e) => ["splash", "swap", "embed-at-start"].includes(e)) && { settleMs: 300 }),
    ...options,
  })
  open.push(target)
  return target
}
// Closing sweeps the system's process table: a slow CI machine gets room.
afterEach(async () => {
  for (const target of open) await target.close()
  open = []
}, 30_000)

/** What the fixture says it saw at start (written into its own data folder). */
const seenBy = async (target: ElectronTarget) => {
  const file = join(target.sandbox, "profile", "seen.json")
  await waitFor(() => existsSync(file))
  return JSON.parse(readFileSync(file, "utf8")) as {
    env: string[]
    home: string
    userData: string
    args: string[]
  }
}

describe("a desktop app's launch", { timeout: 60_000 }, () => {
  it("runs in its own sandbox: its home, its data, never Kiframe's environment", async () => {
    process.env.KIFRAME_TEST_SECRET = "sk-never-for-the-app"
    process.env.NODE_OPTIONS = "--inspect"
    // Linux's display reaches the app (never a window without it); macOS ignores it.
    const display = process.env.DISPLAY
    process.env.DISPLAY ??= ":kiframe-test"
    try {
      const target = await launch()
      const seen = await seenBy(target)
      expect(seen.home).toBe(join(target.sandbox, "home"))
      // Its data in the sandbox (--user-data-dir). Electron's appData and macOS preferences stay
      // the user's (found 2026-10-08: neither HOME nor CFFIXED_USER_HOME moves them): the trial
      // launch checks an app keeps its state in the sandbox.
      expect(seen.userData).toBe(join(target.sandbox, "profile"))
      expect(seen.env).not.toContain("KIFRAME_TEST_SECRET")
      expect(seen.env).not.toContain("NODE_OPTIONS")
      expect(seen.env.filter((e) => e.startsWith("ELECTRON_"))).toEqual([])
      expect(seen.env).toEqual(
        expect.arrayContaining(["HOME", "CFFIXED_USER_HOME", "TMPDIR", "DISPLAY"]),
      )
      // The project's arguments come before Kiframe's switches, as given.
      expect(seen.args.slice(0, 3)).toEqual([fixture, "hidden", `link=${other}`])
    } finally {
      delete process.env.KIFRAME_TEST_SECRET
      delete process.env.NODE_OPTIONS
      if (display === undefined) delete process.env.DISPLAY
      else process.env.DISPLAY = display
    }
  })

  it("is driven like a web page, at the scene's size, its window hidden", async () => {
    const target = await launch()
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: add, action: click, target: { by: role, role: button, name: Add note } }
  - { id: one, action: expect, that: { text: "Notes: 1" } }
  - { id: wide, action: expect, that: { text: "Width: 800" } }
  - { id: open, action: click, target: { by: role, role: link, name: Settings } }
  - { id: there, action: expect, that: { visible: { by: role, role: heading, name: Settings } } }
`),
      project,
      {
        electron: inTarget(target),
        timeoutMs: 5000,
      },
    )
  })

  it("never lets a step leave the app: the user's files, a website", async () => {
    for (const name of ["Hosts file", "A website"]) {
      const target = await launch()
      const error = await runScenario(
        target.page,
        parseScenarioYaml(`version: 1
steps:
  - { id: out, action: click, target: { by: role, role: link, name: ${name} } }
`),
        project,
        {
          electron: inTarget(target),
          timeoutMs: 5000,
        },
      ).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(error, name).toBeInstanceOf(StepError)
      expect((error as StepError).reason, name).toBe("off-app")
    }
  })

  it("makes a window the app opens ready before the run follows it", async () => {
    const target = await launch()
    const order: string[] = []
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: open, action: click, target: { by: role, role: button, name: Open settings window } }
  - { id: there, action: expect, that: { text: "Settings width: 800" } }
`),
      project,
      {
        electron: {
          app: "notes",
          allows: target.allows,
          stopped: target.stopped,
          quiet: target.quiet,
          prepare: async (p) => {
            order.push("prepare")
            await target.prepare(p)
          },
        },
        onPageSwitch: () => {
          order.push("switch")
          return Promise.resolve()
        },
        timeoutMs: 5000,
      },
    )
    expect(order).toEqual(["prepare", "switch"])
  })

  it("follows a window the app opens, at the scene's size; runs a preset in it", async () => {
    const target = await launch()
    const withPreset = parseProjectYaml(`version: 2
apps:
  notes: { kind: electron, bundleId: com.kiframe.fixture, viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }
presets:
  one: { steps: [{ action: click, target: { by: role, role: button, name: Add note } }] }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
setup: [{ preset: one }]
steps:
  - { id: one, action: expect, that: { text: "Notes: 1" } }
  - { id: open, action: click, target: { by: role, role: button, name: Open settings window } }
  - { id: there, action: expect, that: { text: "Settings width: 800" } }
`),
      withPreset,
      {
        electron: inTarget(target),
        timeoutMs: 5000,
      },
    )
  })

  it("never runs a web scene in a desktop app's window", async () => {
    const target = await launch()
    const both = parseProjectYaml(`version: 2
apps:
  web: { kind: web, url: "https://app.test" }
  notes: { kind: electron, bundleId: com.kiframe.fixture }
`)
    const error = await runScenario(
      target.page,
      parseScenarioYaml(`version: 1\nsteps: [{ id: a, action: pause, ms: 1 }]\n`),
      both,
      { electron: inTarget(target) },
    ).then(
      () => undefined,
      (e: unknown) => e,
    )
    expect((error as StepError).message).toMatch(
      /the scene starts in "web", not in the desktop app "notes" it was given/,
    )
  })

  it("is filmed like a web page", async () => {
    const target = await launch()
    const out = join(mkdtempSync(join(tmpdir(), "kiframe-el-take-")), "take")
    const take = await recordScenario(
      target.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: add, action: click, target: { by: role, role: button, name: Add note } }
  - { id: one, action: expect, that: { text: "Notes: 1" } }
`),
      project,
      {
        outDir: out,
        sceneId: "notes",
        electron: inTarget(target),
      },
    )
    expect(take.meta.appUrl).toBe("electron:com.kiframe.fixture")
    expect(existsSync(join(take.dir, "frames.webm"))).toBe(true)
  })

  it("ends whole: the app, a helper it detached, its sandbox", async () => {
    const target = await launch()
    const pidFile = join(target.sandbox, "profile", "helper.pid")
    expect(await waitFor(() => existsSync(pidFile))).toBe(true)
    const helper = Number(readFileSync(pidFile, "utf8"))
    const groupedFile = join(target.sandbox, "profile", "grouped.pid")
    expect(await waitFor(() => existsSync(groupedFile))).toBe(true)
    const grouped = Number(readFileSync(groupedFile, "utf8"))
    expect(alive(helper)).toBe(true)
    expect(alive(grouped)).toBe(true)
    await target.close()
    open = []
    // Detached (found by the sandbox it holds) and in the app's group (killed with it).
    expect(await waitFor(() => !alive(helper))).toBe(true)
    expect(await waitFor(() => !alive(grouped))).toBe(true)
    expect(existsSync(target.sandbox)).toBe(false)
  })

  it("ends a group whose main process already died (its children never outlive it)", async () => {
    const target = await launch()
    const file = (name: string) => join(target.sandbox, "profile", name)
    expect(
      await waitFor(() => existsSync(file("main.pid")) && existsSync(file("grouped.pid"))),
    ).toBe(true)
    const main = Number(readFileSync(file("main.pid"), "utf8"))
    const grouped = Number(readFileSync(file("grouped.pid"), "utf8"))
    process.kill(main, "SIGKILL")
    expect(await waitFor(() => !alive(main))).toBe(true)
    expect(alive(grouped)).toBe(true)
    await target.close()
    open = []
    expect(await waitFor(() => !alive(grouped))).toBe(true)
  })

  it("never sweeps a launch as it starts (owned from the moment its sandbox exists)", async () => {
    const own = mkdtempSync(join(tmpdir(), "kiframe-el-work-"))
    // Another Kiframe starting meanwhile sweeps the work area again and again.
    let starting = true
    const sweeps = (async () => {
      while (starting) {
        await sweepWorkArea(own)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    })()
    try {
      const target = await launch([], { workDir: own })
      expect(existsSync(target.sandbox)).toBe(true)
      expect(await target.page.title()).toBe("Fixture notes")
    } finally {
      starting = false
      await sweeps
    }
  })

  it("takes a bundle given through a link (its pages report either path)", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "kiframe-el-link-")), "Fixture.app")
    symlinkSync(fixture, link)
    const target = await launchElectron({ ...base, bundle: link, appArgs: [link, "hidden"] })
    open.push(target)
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: open, action: click, target: { by: role, role: link, name: Settings } }
  - { id: there, action: expect, that: { visible: { by: role, role: heading, name: Settings } } }
`),
      project,
      {
        electron: inTarget(target),
        timeoutMs: 5000,
      },
    )
  })

  it("sweeps what a crash left at the next start (its owner gone)", async () => {
    const own = mkdtempSync(join(tmpdir(), "kiframe-el-work-"))
    // A Kiframe that launched the app, then crashed (killed outright: nothing of it ran after).
    const kiframe = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        "--no-warnings",
        join(import.meta.dirname, "fixtures/crash-launch.ts"),
        own,
        electron,
        fixture,
        electronApp,
        fixture,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    )
    let printed = ""
    kiframe.stdout.on("data", (d: Buffer) => (printed += d.toString()))
    const pids: number[] = []
    try {
      expect(await waitFor(() => printed.includes("\n"), 30_000)).toBe(true)
      const sandbox = printed.trim()
      const pid = (name: string) => Number(readFileSync(join(sandbox, "profile", name), "utf8"))
      // main.pid is written last.
      await waitFor(() => existsSync(join(sandbox, "profile", "main.pid")))
      pids.push(pid("main.pid"))
      const helper = pid("helper.pid")
      // And one left in the app's group, pointing nowhere (its cwd /, no sandbox in its command).
      const grouped = pid("grouped.pid")
      pids.push(helper, grouped)
      // While it runs, its launch is its own: never swept.
      expect(await sweepWorkArea(own)).toBe(0)
      kiframe.kill("SIGKILL")
      expect(await waitFor(() => kiframe.exitCode !== null || kiframe.signalCode !== null)).toBe(
        true,
      )
      expect(alive(helper) && alive(grouped)).toBe(true)
      expect(await sweepWorkArea(own)).toBe(1)
      expect(await waitFor(() => !alive(helper) && !alive(grouped))).toBe(true)
      expect(existsSync(sandbox)).toBe(false)
    } finally {
      // Never left running when the test fails midway.
      kiframe.kill("SIGKILL")
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL")
    }
  }, 60_000)

  it("launches an app that allows one copy only (its lock in the sandbox, never /var/folders)", async () => {
    const target = await launch(["single"])
    expect(await target.page.title()).toBe("Fixture notes")
  })

  it("names the site a wrapper app shows, even when it can't load it", async () => {
    const error = await launch(["wrapper"]).then(
      () => undefined,
      (e: unknown) => e as ElectronLaunchError,
    )
    expect(error).toBeInstanceOf(ElectronLaunchError)
    expect(error?.why).toBe("site")
    expect(error?.site).toBe("https://kiframe-wrapper.invalid")
    // Listed as its own but never loaded: said (never a window driven on an error page).
    await expect(
      launch(["wrapper"], { origins: ["https://kiframe-wrapper.invalid"] }),
    ).rejects.toThrow(/couldn't load kiframe-wrapper\.invalid/)
    // Listed and loaded: driven.
    const site = new URL(secure).origin
    const target = await launch([`wrapper=${secure}`, "trust-test-cert"], { origins: [site] })
    expect(target.page.url()).toBe(secure)
  })

  // A fake app: announces a debugging endpoint (a test's server) and, asked, quits after a while.
  const fakeApp = () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-el-fake-"))
    const script = join(dir, "fake-app")
    writeFileSync(
      script,
      `#!${process.execPath}
const [port, quitAfter] = process.argv.slice(2)
process.stderr.write("DevTools listening on ws://127.0.0.1:" + port + "/devtools/browser/0f0e0d0c-0000-4000-8000-000000000000\\n")
if (quitAfter !== "never") setTimeout(() => process.exit(0), Number(quitAfter))
else setInterval(() => undefined, 60_000)
`,
      { mode: 0o755 },
    )
    return { script, readable: [realpathSync(dir), realpathSync(dirname(process.execPath))] }
  }
  const fakeLaunch = (port: number, quitAfter: string, timeoutMs: number) => {
    const fake = fakeApp()
    return launchElectron({
      executable: fake.script,
      appArgs: [String(port), quitAfter],
      readable: fake.readable,
      workDir: work,
      allowUnconfined: true,
      viewport,
      timeoutMs,
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
  }

  it("says a broken debugging connection in its own words (never Playwright's, its endpoint)", async () => {
    // An endpoint that refuses the WebSocket (a CDP it can't speak).
    const refusing = createServer((_req, res) => res.writeHead(404).end())
    await new Promise<void>((resolve) => refusing.listen(0, "127.0.0.1", resolve))
    try {
      const error = await fakeLaunch((refusing.address() as AddressInfo).port, "never", 8000)
      expect(error).toBeInstanceOf(ElectronLaunchError)
      expect(String(error)).toMatch(/couldn't be driven \(its debugging connection failed\)/)
      expect(String(error)).not.toMatch(/ws:\/\/|127\.0\.0\.1/)
    } finally {
      refusing.close()
    }
  }, 30_000)

  it("says an app that quits while its attach stalls as quit (never 'didn't answer')", async () => {
    const silent = createNetServer(() => undefined)
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve))
    try {
      // It quits just after the launch's time: the attach times out, its exit lands after.
      const error = await fakeLaunch((silent.address() as AddressInfo).port, "3300", 3000)
      expect(error).toBeInstanceOf(ElectronLaunchError)
      expect((error as ElectronLaunchError).why).toBe("quit")
    } finally {
      silent.close()
    }
  }, 30_000)

  it("words every failure by one rule: a stop, not started, quit, said, anything else", () => {
    const stop = new DOMException("stopped", "AbortError")
    const said = new ElectronLaunchError("said")
    const raw = new Error("connect ECONNREFUSED ws://127.0.0.1:9/devtools/browser/x")
    const none = { stopped: undefined, spawnError: undefined, quit: false }
    expect(launchFailure(raw, { ...none, stopped: stop, quit: true })).toBe(stop)
    expect(
      String(launchFailure(raw, { ...none, spawnError: new Error("ENOENT"), quit: true })),
    ).toMatch(/couldn't be launched \(ENOENT\)/)
    // Already said (a site to allow, a page never loaded) stays said, even if the app then quit.
    const site = new ElectronLaunchError("site", { why: "site", site: "https://a.example" })
    expect(launchFailure(site, { ...none, quit: true })).toBe(site)
    expect(launchFailure(said, none)).toBe(said)
    // Anything else said (no window in time) or unworded (an attach that stalled), the app gone:
    // it quit (the one-copy advice kept).
    expect(launchFailure(said, { ...none, quit: true })).toMatchObject({ why: "quit" })
    const unloaded = new ElectronLaunchError("unloaded", { why: "unloaded" })
    expect(launchFailure(unloaded, { ...none, quit: true })).toBe(unloaded)
    expect(launchFailure(raw, { ...none, quit: true })).toMatchObject({ why: "quit" })
    const worded = launchFailure(raw, none)
    expect(worded).toBeInstanceOf(ElectronLaunchError)
    expect(String(worded)).not.toMatch(/ws:\/\//)
  })

  it("tries a stalled attach again, then says it as the launch's own (never Playwright's)", async () => {
    // A debugging endpoint that accepts and never answers.
    let connections = 0
    const silent = createNetServer(() => (connections += 1))
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve))
    const port = (silent.address() as AddressInfo).port
    try {
      const error = await attach(
        `ws://127.0.0.1:${port}/devtools/browser/x`,
        Date.now() + 7000,
      ).then(
        () => undefined,
        (e: unknown) => e,
      )
      // Tried twice, then the timeout handed to the launch's one rule, which words it.
      expect(connections).toBe(2)
      expect(error).toBeInstanceOf(errors.TimeoutError)
      const worded = launchFailure(error, {
        stopped: undefined,
        spawnError: undefined,
        quit: false,
      })
      expect(worded).toBeInstanceOf(ElectronLaunchError)
      expect(String(worded)).toMatch(/didn't answer in time/)
    } finally {
      silent.close()
    }
  }, 30_000)

  it("says a dev build whose server isn't running, as such (never an off-app site)", async () => {
    const closed = createNetServer()
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve))
    const port = (closed.address() as AddressInfo).port
    await new Promise((resolve) => closed.close(resolve))
    await expect(launch([`dev-down=http://127.0.0.1:${port}/`])).rejects.toThrow(
      new RegExp(
        `couldn't load 127\\.0\\.0\\.1:${port} \\(offline\\? its server not running\\?\\)`,
      ),
    )
  })

  it("says an app that quits at once, and leaves nothing behind", async () => {
    const before = sandboxCount()
    await expect(launch(["quit-at-once"])).rejects.toThrow(ElectronLaunchError)
    await expect(launch(["quit-at-once"])).rejects.toThrow(/quit before Kiframe could attach/)
    await expect(launch(["quit-at-once"])).rejects.toMatchObject({ why: "quit" })
    expect(sandboxCount()).toBe(before)
  })

  it("learns its own scheme from a window it opens after a splash (never from a step)", async () => {
    const target = await launch(["splash"])
    expect(
      await waitFor(() => target.context.pages().some((p) => p.url().startsWith("app:")), 8000),
    ).toBe(true)
    expect(target.allows("app://local/index.html")).toBe(true)
    expect(target.allows("other://local/index.html")).toBe(false)
    // Its main window (the splash closed or not, the last one opened) is the one driven.
    expect(target.page.url()).toBe("app://local/index.html")
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: add, action: click, target: { by: role, role: button, name: Add note } }
  - { id: one, action: expect, that: { text: "Notes: 1" } }
`),
      project,
      {
        electron: inTarget(target),
        timeoutMs: 5000,
      },
    )
  })

  it("guards every window and frame: a site's window closed, the user's file blanked, said", async () => {
    const run = async (button: string) => {
      const target = await launch()
      const error = await runScenario(
        target.page,
        parseScenarioYaml(`version: 1
steps:
  - { id: out, action: click, target: { by: role, role: button, name: ${button} } }
  - { id: beat, action: pause, ms: 1500 }
`),
        project,
        {
          electron: inTarget(target),
          timeoutMs: 5000,
        },
      ).then(
        () => undefined,
        (e: unknown) => e as StepError,
      )
      return { target, error }
    }
    const site = await run("Open website window")
    expect(site.error?.reason).toBe("off-app")
    expect(site.error?.message).toMatch(/the app's window went to 127\.0\.0\.1:\d+/)
    expect(site.target.context.pages().some((p) => p.url().startsWith(other))).toBe(false)
    const file = await run("Embed hosts")
    expect(file.error?.message).toMatch(/went to a file on this computer/)
    // The frame is blank (never left showing the file to a read).
    expect(file.target.page.frames().some((f) => f.url().startsWith("file:///etc"))).toBe(false)
    // The app's own page in a frame is its own.
    expect((await run("Embed settings")).error).toBeUndefined()
  })

  it("confines a desktop window while grounding too (the user's files never reach a read)", async () => {
    const target = await launch()
    const error = await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: out, action: click, target: { by: role, role: link, name: Hosts file } }
`),
      project,
      {
        electron: inTarget(target),
        confineToApps: false,
        timeoutMs: 5000,
      },
    ).then(
      () => undefined,
      (e: unknown) => e as StepError,
    )
    expect(error?.reason).toBe("off-app")
  })

  it("keeps no sign-in between runs yet, skips a web rule's goto, ends once", async () => {
    const target = await launch()
    const scene = parseScenarioYaml(`version: 1\nsteps: [{ id: a, action: pause, ms: 1 }]\n`)
    await expect(
      runScenario(target.page, scene, project, {
        electron: inTarget(target),
        skipSessionPresets: ["login"],
      }),
    ).rejects.toThrow(/a desktop app's sign-in isn't kept between runs yet/)
    const withRule = parseProjectYaml(`version: 2
apps:
  notes: { kind: electron, bundleId: com.kiframe.fixture, viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }
  web: { kind: web, url: "https://app.test" }
interrupts:
  - { id: cookies, when: { by: role, role: button, name: Add note }, do: { action: goto, app: web, url: / } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const warnings: string[] = []
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
app: notes
steps: [{ id: add, action: click, target: { by: role, role: button, name: Add note } }]
`),
      withRule,
      {
        electron: inTarget(target),
        onEvent: (e) => e.kind === "warning" && warnings.push(e.message),
      },
    )
    expect(warnings).toContain(
      'interrupt rule "cookies" is skipped in the desktop app: it needs a web app\'s address',
    )
    // Once: a second call is the same ending (never a second signal to a group id).
    const first = target.close()
    expect(target.close()).toBe(first)
    expect(await first).toEqual({ unread: false })
    open = []
  })

  it("keeps what the app embeds as it opens, and takes its window back from a site", async () => {
    // A frame of another (https) site shown at launch is the app as shipped: never a stop.
    const embeds = await launchElectron({
      ...base,
      appArgs: [fixture, "hidden", `link=${secure}`, "embed-at-start", "trust-test-cert"],
    })
    open.push(embeds)
    await runScenario(
      embeds.page,
      parseScenarioYaml(`version: 1\nsteps: [{ id: a, action: pause, ms: 300 }]\n`),
      project,
      { electron: inTarget(embeds) },
    )
    expect(embeds.page.frames().some((f) => f.url() === secure)).toBe(true)
    // A plain-http frame at launch is never the app's: stopped (and never blamed on a run).
    const plain = await launch(["embed-at-start"])
    await runScenario(
      plain.page,
      parseScenarioYaml(`version: 1\nsteps: [{ id: a, action: pause, ms: 300 }]\n`),
      project,
      { electron: inTarget(plain) },
    )
    expect(plain.page.frames().some((f) => f.url() === other)).toBe(false)
    // The main window that went to a site comes back to the app (never left blank: no goto here).
    const target = await launch()
    const options = {
      electron: inTarget(target),
      timeoutMs: 5000,
    }
    await expect(
      runScenario(
        target.page,
        parseScenarioYaml(`version: 1
steps:
  - { id: out, action: click, target: { by: role, role: link, name: A website } }
  - { id: beat, action: pause, ms: 1000 }
`),
        project,
        options,
      ),
    ).rejects.toThrow(/went to 127\.0\.0\.1/)
    await waitFor(() => target.page.url().includes("index.html"), 10_000)
    // Its address said if not (a busy CI machine: what it was on).
    expect(target.page.url()).toMatch(/index\.html/)
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: add, action: click, target: { by: role, role: button, name: Add note } }
  - { id: one, action: expect, that: { text: "Notes: 1" } }
`),
      project,
      options,
    )
  })

  it("never blames a run for what was stopped before it; says a failed load as one", async () => {
    const target = await launch()
    const options = {
      electron: inTarget(target),
      timeoutMs: 5000,
    }
    // Stopped outside any run (an earlier failed step): the next run isn't blamed.
    await target.page.getByRole("button", { name: "Embed hosts" }).click()
    await new Promise((r) => setTimeout(r, 500))
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1\nsteps: [{ id: a, action: pause, ms: 1 }]\n`),
      project,
      options,
    )
    const dead = await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: out, action: click, target: { by: role, role: link, name: A dead link } }
  - { id: beat, action: pause, ms: 1000 }
`),
      project,
      options,
    ).then(
      () => undefined,
      (e: unknown) => e as StepError,
    )
    expect(dead?.message).toMatch(/the page failed to load/)
  })

  it("runs a batch's scene (its session hook never called), skips a URL-waiting rule", async () => {
    const target = await launch()
    const withRule = parseProjectYaml(`version: 2
apps:
  notes: { kind: electron, bundleId: com.kiframe.fixture, viewport: { width: 800, height: 600, deviceScaleFactor: 1 } }
  web: { kind: web, url: "https://app.test" }
presets:
  login: { app: notes, session: true, steps: [{ action: click, target: { by: role, role: button, name: Add note } }] }
interrupts:
  - { id: home, when: { by: role, role: button, name: Add note }, do: { action: waitFor, until: { url: /home, app: web } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const warnings: string[] = []
    let saved = 0
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
app: notes
setup: [{ preset: login }]
steps: [{ id: add, action: click, target: { by: role, role: button, name: Add note } }]
`),
      withRule,
      {
        electron: inTarget(target),
        onSessionReady: () => {
          saved++
          return Promise.resolve()
        },
        onEvent: (e) => e.kind === "warning" && warnings.push(e.message),
      },
    )
    expect(saved).toBe(0)
    expect(warnings).toContain(
      'interrupt rule "home" is skipped in the desktop app: it needs a web app\'s address',
    )
  })

  it("follows the windows its main process opens: a sign-in window replaced, Preferences", async () => {
    const swap = await launch(["swap"])
    await runScenario(
      swap.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: wait, action: pause, ms: 4000 }
  - { id: add, action: click, target: { by: role, role: button, name: Add note } }
  - { id: one, action: expect, that: { text: "Notes: 1" } }
`),
      project,
      { electron: inTarget(swap), timeoutMs: 5000 },
    )
    const prefs = await launch(["prefs"])
    await runScenario(
      prefs.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: wait, action: pause, ms: 3500 }
  - { id: there, action: expect, that: { visible: { by: role, role: heading, name: Settings } } }
  - { id: wide, action: expect, that: { text: "Settings width: 800" } }
`),
      project,
      { electron: inTarget(prefs), timeoutMs: 5000 },
    )
  })

  it("never counts the app's own DevTools as leaving it", async () => {
    const target = await launch(["devtools"])
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: wait, action: pause, ms: 1500 }
  - { id: add, action: click, target: { by: role, role: button, name: Add note } }
`),
      project,
      { electron: inTarget(target), timeoutMs: 5000 },
    )
  })

  it("follows a window that opens blank and loads later; a frame of another window is said only", async () => {
    const target = await launch()
    const warnings: string[] = []
    const options = {
      electron: inTarget(target),
      timeoutMs: 5000,
      onEvent: (e: { kind: string; message?: string }) => {
        if (e.kind === "warning" && e.message !== undefined) warnings.push(e.message)
      },
    }
    await runScenario(
      target.page,
      parseScenarioYaml(`version: 1
steps:
  - { id: open, action: click, target: { by: role, role: button, name: Open window that loads later } }
  - { id: there, action: expect, that: { visible: { by: role, role: heading, name: Settings } } }
  - { id: other, action: pause, ms: 1 }
`),
      project,
      {
        ...options,
        onPageSwitch: async () => {
          // The run is on the new window: the main window (not driven) embeds the user's file.
          await target.page.getByRole("button", { name: "Embed hosts" }).click()
          await new Promise((r) => setTimeout(r, 500))
        },
      },
    )
    expect(warnings).toContain(
      'a frame of another window of "notes" went to a file on this computer: Kiframe stopped it',
    )
  })

  it("is quiet only once its stops are done (a read never sees a window mid-stop)", async () => {
    const target = await launch()
    for (let i = 0; i < 3; i++) {
      await target.page.getByRole("button", { name: "Embed hosts" }).click()
      // Wait for the stop to be recorded (as a step's end would), then for the guard to be done.
      await waitFor(() => target.context.pages()[0]?.frames().length !== 1)
      await target.quiet()
      expect(target.page.frames().some((f) => f.url().startsWith("file:///etc"))).toBe(false)
    }
  })

  it("says a window left blank (nothing to go back to): relaunch", async () => {
    const target = await launch()
    const step = (yaml: string) =>
      runScenario(target.page, parseScenarioYaml(`version: 1\nsteps:\n${yaml}`), project, {
        electron: inTarget(target),
        timeoutMs: 5000,
      }).then(
        () => "ran",
        (e: unknown) => (e as Error).message,
      )
    expect(
      await step(`  - { id: out, action: click, target: { by: role, role: button, name: Replace with website } }
  - { id: beat, action: pause, ms: 1500 }`),
    ).toMatch(/went to 127\.0\.0\.1/)
    expect(await step("  - { id: a, action: pause, ms: 1 }")).toMatch(
      /the app's window is blank .*: relaunch "notes"/,
    )
  })

  it("refuses an app whose main window isn't its own at launch, said where it is", async () => {
    await expect(launch(["elsewhere"])).rejects.toThrow(
      "the app shows a data: page: if that's the app's own, list it in its origins",
    )
  })

  it("says an app that isn't there any more, or can't start, never crashing the host", async () => {
    await expect(launchElectron({ ...base, bundle: "/Applications/Gone.app" })).rejects.toThrow(
      "the app isn't at /Applications/Gone.app any more",
    )
    await expect(
      launchElectron({ ...base, executable: "/no/such/executable", timeoutMs: 5000 }),
    ).rejects.toThrow(/the app couldn't be launched/)
  })

  it("keeps a desktop scene in its app: no goto, URL condition or web preset there", async () => {
    const target = await launch()
    const both = parseProjectYaml(`version: 2
apps:
  notes: { kind: electron, bundleId: com.kiframe.fixture }
  web: { kind: web, url: "https://app.test" }
presets:
  login: { app: web, steps: [{ action: goto, url: /login }] }
`)
    const failure = (yaml: string) =>
      runScenario(target.page, parseScenarioYaml(`version: 1\n${yaml}`), both, {
        electron: inTarget(target),
        timeoutMs: 3000,
      }).then(
        () => "ran",
        (e: unknown) => (e as Error).message,
      )
    expect(
      await failure("setup: [{ preset: login }]\nsteps: [{ id: a, action: pause, ms: 1 }]"),
    ).toMatch(/a scene in the desktop app "notes" stays in it/)
    expect(await failure("steps: [{ id: a, action: goto, app: web, url: / }]")).toMatch(
      /a goto can't run in a desktop app's scene/,
    )
    expect(
      await failure("steps: [{ id: a, action: waitFor, until: { url: /, app: web } }]"),
    ).toMatch(/a URL condition can't run in a desktop app's scene/)
    expect(target.page.url()).toMatch(/^file:/)
  })

  it("stops when the run is stopped while it launches", async () => {
    const stop = new AbortController()
    const launching = launchElectron({
      ...base,
      appArgs: [fixture, "hidden"],
      signal: stop.signal,
    })
    stop.abort(new Error("stopped"))
    await expect(launching).rejects.toThrow(/stopped/)
  })
})

describe("a desktop app's own pages", () => {
  const own = {
    bundles: ["/Applications/Notes.app"],
    trusted: ["/tmp/kiframe-app-x/home", "/tmp/kiframe-app-x/profile"],
    launched: new Set(["http://localhost:5173"]),
    schemes: new Set(["app:", "vscode-file:"]),
    origins: ["https://app.slack.com"],
  }
  it("are its bundle's and sandbox's files, its launch-time dev server and schemes, its sites", () => {
    for (const url of [
      "about:blank",
      "file:///Applications/Notes.app/Contents/Resources/app/index.html",
      "file:///tmp/kiframe-app-x/profile/page.html",
      "http://localhost:5173/settings",
      "https://app.slack.com/client/T1",
      "app://notes/index.html",
      "vscode-file://vscode-app/x.html",
      "blob:https://app.slack.com/123",
      // A file: page's blob (no path to check: made by the app's own pages).
      "blob:file:///3f2a-41c1",
      // Its site as one site (www.).
      "https://www.app.slack.com/client",
    ]) {
      expect(allowedPage(url, own), url).toBe(true)
    }
  })
  it("are never the user's files, another site or port, or a data: page", () => {
    for (const url of [
      "file:///etc/hosts",
      // The sandbox's copy of the project's files/ (its content: never the app's own pages).
      "file:///tmp/kiframe-app-x/files/demo/index.html",
      "file:///tmp/kiframe-app-x/tmp/x.html",
      "file:///Applications/Notes.app.evil/x.html",
      "file:///Applications/Notes.app/../Mail.app/x.html",
      "file:///Users/me/Documents/secret.pdf",
      "http://localhost:8080/",
      "https://example.com/",
      "https://app.slack.com.evil.test/",
      "data:text/html,<h1>x</h1>",
      "chrome-error://chromewebdata/",
      "blob:https://example.com/123",
      // Another app's scheme, a site's sandboxed files, Chromium's pages, another host's file.
      "other-app://x/index.html",
      "filesystem:https://example.com/temporary/x.html",
      "chrome-extension://abc/page.html",
      "about:srcdoc",
      "file://server/Applications/Notes.app/index.html",
      // Decoding can make `..` the URL parser left alone.
      "file:///Applications/Notes.app/..%2F..%2Fetc/hosts",
      "blob:file://server/abc",
      // Never plain http for an https site.
      "http://app.slack.com/client",
    ]) {
      expect(allowedPage(url, own), url).toBe(false)
    }
  })
})

// The confinement (macOS's Seatbelt, measured 2026-10-09): every escape refused, the app driven.
describe.runIf(process.platform === "darwin")(
  "a desktop app's confinement",
  { timeout: 60_000 },
  () => {
    it("refuses every escape it tries: the user's folders, other launchers, sockets, the keychain", async () => {
      const outside = join(mkdtempSync(join(tmpdir(), "kiframe-el-outside-")), "private.txt")
      writeFileSync(outside, "the user's own file")
      // An agent's socket outside the sandbox (as ssh-agent's, Docker's): it would accept.
      const socket = `/private/tmp/kf-${process.pid}.sock`
      const agent = createNetServer((c) => c.end())
      await new Promise<void>((resolve) => agent.listen(socket, resolve))
      const probes = [
        join(userInfo().homedir, "Library", "KiframeProbe.txt"),
        "/Users/Shared/KiframeProbe.txt",
        "/private/tmp/KiframeProbe.txt",
        "/Applications/KiframeProbe.txt",
      ]
      try {
        const target = await launch(["probes", `outside=${outside}`, `socket=${socket}`])
        const file = join(target.sandbox, "profile", "probes.json")
        expect(await waitFor(() => existsSync(file), 10_000)).toBe(true)
        const seen = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>
        for (const escape of [
          "write-real-home",
          "read-real-home",
          "write-users-shared",
          "write-private-tmp",
          "write-applications",
          "read-outside",
          "hardlink-outside",
          "exec-open",
          "exec-osascript",
          "exec-launchctl",
          "exec-copied",
          "socket-agent",
        ]) {
          // Refused by the confinement itself (never an error of another kind passing for one).
          expect(seen[escape], escape).toBe("DENIED EPERM")
        }
        // Never the user's clipboard (measured: an unconfined read saw what the host had copied).
        expect(seen["clipboard-read"]).toBe("0")
        // A mock keychain (never the user's): encryption still works for the app.
        expect(seen["keychain-encrypts"]).toBe("OK true")
        // And the app is driven as usual.
        await runScenario(
          target.page,
          parseScenarioYaml(`version: 1
steps:
  - { id: add, action: click, target: { by: role, role: button, name: Add note } }
  - { id: one, action: expect, that: { text: "Notes: 1" } }
`),
          project,
          { electron: inTarget(target), timeoutMs: 5000 },
        )
      } finally {
        // A probe that got through would have left its file: never kept.
        for (const probe of probes) rmSync(probe, { force: true })
        agent.close()
      }
    })

    it("never launches when the confinement doesn't hold (a canary is read)", async () => {
      // A profile that lets the canary be read (its folder readable): refused, no app started.
      const own = mkdtempSync(join(tmpdir(), "kiframe-el-work-"))
      await expect(
        launch([], { workDir: own, readable: [electronApp, realpathSync(own)] }),
      ).rejects.toThrow(/the confinement didn't hold/)
      expect(readdirSync(join(own, "sandboxes"))).toEqual([])
    })

    it("never lets launches at once spoil each other's canary", async () => {
      // Broken launches (their canary readable) beside sound ones that end right after their
      // canary (an argument missing): a shared canary removed by one is "unread" by another.
      const own = mkdtempSync(join(tmpdir(), "kiframe-el-work-"))
      const [broken, sound] = await Promise.all([
        Promise.allSettled(
          Array.from({ length: 8 }, () =>
            launch([], { workDir: own, readable: [electronApp, realpathSync(own)] }),
          ),
        ),
        Promise.allSettled(
          Array.from({ length: 8 }, () => launch([], { workDir: own, args: ["files/missing"] })),
        ),
      ])
      for (const b of broken) {
        expect(b.status === "rejected" && String(b.reason)).toMatch(/didn't hold/)
      }
      // The sound ones fail only for what they lack (never their canary spoiled by another).
      for (const s of sound) {
        expect(s.status === "rejected" && String(s.reason)).toMatch(/isn't in files/)
      }
      // None left (each beside its sandbox, removed with it).
      expect(readdirSync(join(own, "sandboxes")).filter((n) => n.endsWith(".canary"))).toEqual([])
    })

    it("never passes a canary that went missing for one that was refused", async () => {
      // Every canary removed as soon as it's written (as another launch would): unread for that
      // reason, the check proves nothing, and a broken confinement must still never pass.
      const own = mkdtempSync(join(tmpdir(), "kiframe-el-work-"))
      sandboxesOf(own)
      // Polled on every turn of the loop: faster than a confined program starts.
      let watching = true
      const remove = () => {
        for (const name of readdirSync(join(own, "sandboxes"))) {
          if (name.endsWith(".canary")) rmSync(join(own, "sandboxes", name), { force: true })
        }
        if (watching) setImmediate(remove)
      }
      remove()
      try {
        await expect(
          launch([], { workDir: own, readable: [electronApp, realpathSync(own)] }),
        ).rejects.toThrow(ElectronLaunchError)
      } finally {
        watching = false
      }
    })

    it("never passes a confinement that runs nothing for one that refuses", async () => {
      // A sandbox named through a link (/var → /private/var): Seatbelt matches real paths, so the
      // confined read of its own sandbox fails, as it would were sandbox-exec broken.
      const real = mkdtempSync(join(realpathSync(tmpdir()), "kiframe-el-canary-"))
      const linked = real.replace(/^\/private\/var\//, "/var/")
      expect(linked).not.toBe(real)
      await expect(
        checkConfinement(
          { sandbox: linked, readable: [], private: [] },
          join(mkdtempSync(join(tmpdir(), "kiframe-el-work-")), "canary.txt"),
        ),
      ).rejects.toThrow(/doesn't run programs/)
    })

    it("never reads the user's home wherever it is (a home outside /Users)", async () => {
      // /var/tmp: outside every folder the profile denies by itself (as a /Network/Users home).
      const home = mkdtempSync("/private/var/tmp/kiframe-el-home-")
      const sandbox = mkdtempSync(join(realpathSync(tmpdir()), "kiframe-el-sb-"))
      const confinement = { sandbox, readable: [] } as const
      try {
        // Denied (the canary unread) only as one of the user's own folders.
        await expect(
          checkConfinement({ ...confinement, private: [home] }, join(home, "canary.txt")),
        ).resolves.toBeUndefined()
        await expect(
          checkConfinement({ ...confinement, private: [] }, join(home, "canary.txt")),
        ).rejects.toThrow(/didn't hold/)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    it("leaves the network to the app (its backend), never other programs' sockets", () => {
      const profile = seatbeltProfile({ sandbox: "/s", readable: [], private: [] })
      expect(profile).not.toContain("(deny network-outbound)\n")
      expect(profile).toContain("(deny network-outbound (remote unix-socket))")
    })
  },
)

// The project's files/ (decided 2026-10-09): copied into each launch, what its arguments name.
describe("a desktop app's files", { timeout: 60_000 }, () => {
  const filesWith = (entries: Record<string, string>) => {
    const dir = join(mkdtempSync(join(tmpdir(), "kiframe-el-files-")), "files")
    for (const [path, content] of Object.entries(entries)) {
      mkdirSync(join(dir, path, ".."), { recursive: true })
      writeFileSync(join(dir, path), content)
    }
    return dir
  }

  it("opens a copy of the project's files: its edits never reach the project", async () => {
    const files = filesWith({ "vault/note.md": "the project's note", "vault/sub/deep.md": "deep" })
    const target = await launch(["touch-arg"], { files, args: ["files/vault"] })
    const seen = await seenBy(target)
    const copy = join(target.sandbox, "files", "vault")
    expect(seen.args).toContain(copy)
    expect(readFileSync(join(copy, "sub", "deep.md"), "utf8")).toBe("deep")
    expect(
      await waitFor(() => readFileSync(join(copy, "note.md"), "utf8") === "edited by the app"),
    ).toBe(true)
    expect(readFileSync(join(files, "vault", "note.md"), "utf8")).toBe("the project's note")
    // The copy is the project's content, never the app's own pages (a page there: off-app).
    expect(target.allows(pathToFileURL(join(copy, "note.md")).href)).toBe(false)
    expect(target.allows(pathToFileURL(join(target.sandbox, "profile", "x.html")).href)).toBe(true)
    // Its temp too (a print preview it writes there is its own page).
    expect(target.allows(pathToFileURL(join(target.sandbox, "tmp", "preview.html")).href)).toBe(
      true,
    )
  })

  // A files/ slower to copy than the app takes to start, by far (sized here, on this machine:
  // its tests' timing holds wherever they run). Built once, removed after.
  describe("slow to copy", { timeout: 300_000 }, () => {
    let root: string
    let files: string
    let mirror: string
    let copyMs = 0
    let budget = 0
    const limit = FILES_LIMITS.files
    const copyTime = async () => {
      const to = join(mkdtempSync(join(root, "copy-")), "files")
      const t0 = Date.now()
      await copyFiles(files, to)
      const ms = Date.now() - t0
      rmSync(dirname(to), { recursive: true, force: true })
      return ms
    }

    beforeAll(async () => {
      // The app's own time to start, measured: it's given twice that and a second.
      const t0 = Date.now()
      await (await launch()).close()
      budget = 2 * (Date.now() - t0) + 1000
      root = mkdtempSync(join(tmpdir(), "kiframe-el-slow-"))
      files = join(root, "files")
      FILES_LIMITS.files = 400_000
      // Grown until its copy takes well over the app's time (all of it under files/vault).
      for (let batch = 0; copyMs < budget + 1000 && batch < 60; batch++) {
        for (let d = 0; d < 50; d++) {
          const dir = join(files, "vault", `d${batch}-${d}`)
          mkdirSync(dir, { recursive: true })
          for (let f = 0; f < 100; f++) writeFileSync(join(dir, `f${f}`), "x")
        }
        copyMs = await copyTime()
      }
      expect(copyMs).toBeGreaterThan(budget + 1000)
      // The same folders elsewhere (what a folder swapped for a link would show).
      mirror = join(root, "mirror")
      execFileSync("cp", [
        process.platform === "darwin" ? "-cR" : "-R",
        join(files, "vault"),
        mirror,
      ])
    }, 300_000)

    afterAll(() => {
      FILES_LIMITS.files = limit
      if (root !== undefined) rmSync(root, { recursive: true, force: true })
    })

    it("gives the app its whole time to start, however long its files take to copy", async () => {
      // Were the copy counted, the app would have no time left.
      const target = await launch([], { files, timeoutMs: budget })
      expect(await target.page.title()).toBe("Fixture notes")
    })

    it("never starts the app when stopped while its files copy", async () => {
      const before = sandboxCount()
      const stopping = new AbortController()
      const launching = launch([], { files, signal: stopping.signal })
      setTimeout(() => stopping.abort(), 300)
      const t0 = Date.now()
      // The stop itself (never another error), said at once (never once the copy is done).
      await expect(launching).rejects.toMatchObject({ name: "AbortError" })
      expect(Date.now() - t0).toBeLessThan(copyMs / 2)
      expect(sandboxCount()).toBe(before)
    })

    it("refuses a folder swapped for a link while its files copy", async () => {
      const vault = join(files, "vault")
      const launching = launch([], { files })
      // Mid-copy, vault becomes a link to the same folders elsewhere: every entry still found.
      setTimeout(() => {
        renameSync(vault, join(root, "vault-moved"))
        symlinkSync(mirror, vault)
      }, 300)
      try {
        await expect(launching).rejects.toThrow(/files\/vault.* changed while it was copied/)
      } finally {
        rmSync(vault, { force: true })
        renameSync(join(root, "vault-moved"), vault)
      }
    })
  })

  it("refuses what isn't a file or a folder in files/, and arguments outside it", async () => {
    const linked = filesWith({ "vault/note.md": "x" })
    symlinkSync("/etc/hosts", join(linked, "vault", "hosts"))
    await expect(launch([], { files: linked, args: ["files/vault"] })).rejects.toThrow(
      /files\/vault\/hosts isn't a file or a folder/,
    )
    const files = filesWith({ "vault/note.md": "x" })
    for (const arg of ["files/../escape", "/etc", "vault", "files", "files/missing"]) {
      await expect(launch([], { files, args: [arg] }), arg).rejects.toThrow(ElectronLaunchError)
    }
    // files/ itself a link (a shared project's, to the user's documents): never followed.
    const elsewhere = filesWith({ "vault/secret.md": "the user's" })
    const project = join(mkdtempSync(join(tmpdir(), "kiframe-el-files-")), "files")
    symlinkSync(elsewhere, project)
    await expect(launch([], { files: project, args: ["files/vault"] })).rejects.toThrow(
      /files\/ isn't a folder \(a link\?\)/,
    )
    // Folders count toward the limit (a tree of empty ones is as slow to copy and remove).
    const wide = filesWith({})
    mkdirSync(wide, { recursive: true })
    for (let i = 0; i < 6; i++) mkdirSync(join(wide, `d${i}`))
    const limit = FILES_LIMITS.files
    FILES_LIMITS.files = 5
    try {
      await expect(launch([], { files: wide })).rejects.toThrow(/too large to copy/)
    } finally {
      FILES_LIMITS.files = limit
    }
    // A project without its files/ folder: said as such (never a raw error).
    await expect(
      launch([], { files: join(dirname(files), "absent"), args: ["files/vault"] }),
    ).rejects.toThrow(/the project has no files\/ folder/)
    expect(sandboxCount()).toBe(0)
  })
})

// The work area: only its own sandboxes swept, never another running Kiframe's, never a link.
describe("the work area", () => {
  // A work area with: a launch of another running Kiframe, one whose Kiframe ended, one carrying
  // this process's id from before (a reboot reuses ids), an unowned one, a link to elsewhere.
  const workArea = (other: number) => {
    const own = mkdtempSync(join(tmpdir(), "kiframe-el-work-"))
    const sandboxes = join(own, "sandboxes")
    mkdirSync(sandboxes, { recursive: true, mode: 0o700 })
    const startOf = (pid: number) =>
      Math.round(
        Date.parse(
          execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
            encoding: "utf8",
            env: { ...process.env, LC_ALL: "C" },
          }).trim(),
        ) / 1000,
      )
    const at = {
      live: join(sandboxes, `kiframe-app-${other}-${startOf(other)}-a`),
      ended: join(sandboxes, `kiframe-app-${spawnSync("true").pid}-${startOf(process.pid)}-b`),
      reused: join(sandboxes, `kiframe-app-${process.pid}-${startOf(process.pid) - 3600}-c`),
      unowned: join(sandboxes, "kiframe-app-d"),
      link: join(sandboxes, "kiframe-app-link"),
      elsewhere: mkdtempSync(join(tmpdir(), "users-files-")),
    }
    for (const dir of [at.live, at.ended, at.reused, at.unowned]) mkdirSync(dir)
    // Canaries beside their sandboxes, as a crash mid-check leaves them.
    for (const dir of [at.live, at.ended]) writeFileSync(`${dir}.canary`, "canary")
    symlinkSync(at.elsewhere, at.link)
    return { own, at }
  }

  it("sweeps what no running Kiframe owns, never another's launch, a link or what's elsewhere", async () => {
    // Another Kiframe running (a dev build): its launch is left alone, in any language.
    const other = spawn("sleep", ["30"], { stdio: "ignore" })
    const locale = process.env["LC_ALL"]
    try {
      const { own, at } = workArea(other.pid!)
      process.env["LC_ALL"] = "ko_KR.UTF-8"
      expect(await sweepWorkArea(own)).toBe(4)
      expect([at.ended, `${at.ended}.canary`, at.reused, at.unowned].filter(existsSync)).toEqual([])
      expect(existsSync(at.live) && existsSync(`${at.live}.canary`)).toBe(true)
      expect(existsSync(at.elsewhere)).toBe(true)
      expect(lstatSync(at.link).isSymbolicLink()).toBe(true)
    } finally {
      if (locale === undefined) delete process.env["LC_ALL"]
      else process.env["LC_ALL"] = locale
      other.kill()
    }
  })

  it("sweeps nothing when it can't tell who runs (ps unreadable)", async () => {
    const other = spawn("sleep", ["30"], { stdio: "ignore" })
    const path = process.env["PATH"]
    try {
      const { own, at } = workArea(other.pid!)
      process.env["PATH"] = mkdtempSync(join(tmpdir(), "kiframe-el-nops-"))
      expect(await sweepWorkArea(own)).toBe(0)
      expect([at.live, at.ended, at.reused].every(existsSync)).toBe(true)
    } finally {
      process.env["PATH"] = path
      other.kill()
    }
  })

  it("is the user's alone (0700), never a link", () => {
    const own = mkdtempSync(join(tmpdir(), "kiframe-el-work-"))
    chmodSync(own, 0o755)
    sandboxesOf(own)
    expect(statSync(own).mode & 0o777).toBe(0o700)
    expect(statSync(join(own, "sandboxes")).mode & 0o777).toBe(0o700)
    const linked = join(mkdtempSync(join(tmpdir(), "kiframe-el-link-")), "work")
    symlinkSync(own, linked)
    expect(() => sandboxesOf(linked)).toThrow(/isn't a folder/)
  })
})
