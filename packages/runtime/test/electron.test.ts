import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { createServer, type Server } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import {
  allowedPage,
  ElectronLaunchError,
  type ElectronTarget,
  launchElectron,
  recordScenario,
  runScenario,
  StepError,
  sweepElectronOrphans,
} from "../src/index.ts"

// The Electron target (OBJECT-MODEL §0.9 "Electron apps"): a fixture desktop app launched in a
// sandbox with the repo's own Electron, driven and filmed like a web page, ended whole.

const electron = createRequire(join(import.meta.dirname, "../../../apps/desktop/package.json"))(
  "electron",
) as string
const fixture = join(import.meta.dirname, "fixtures/electron-app")
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 }

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
const launch = async (extra: string[] = [], options: { stateFile?: string } = {}) => {
  const target = await launchElectron({
    executable: electron,
    bundle: fixture,
    args: [fixture, "hidden", `link=${other}`, ...extra],
    // A plain fixture settles at once; the window-shape tests keep the real wait.
    ...(!extra.some((e) => ["splash", "swap", "embed-at-start"].includes(e)) && { settleMs: 300 }),
    viewport,
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

  it("never leaves an app running when its launch can't be noted", async () => {
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith("kiframe-app-")).length
    await expect(
      launch([], { stateFile: join(tmpdir(), "no-such-folder-x", "launches.json") }),
    ).rejects.toThrow()
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith("kiframe-app-")).length).toBe(before)
  })

  it("takes a bundle given through a link (its pages report either path)", async () => {
    const link = join(mkdtempSync(join(tmpdir(), "kiframe-el-link-")), "Fixture.app")
    symlinkSync(fixture, link)
    const target = await launchElectron({
      executable: electron,
      bundle: link,
      args: [link, "hidden"],
      viewport,
    })
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

  it("sweeps what a crash left (by the files they hold), at the next start", async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "kiframe-el-state-")), "launches.json")
    const target = await launch([], { stateFile })
    const pidFile = join(target.sandbox, "profile", "helper.pid")
    await waitFor(() => existsSync(pidFile))
    const helper = Number(readFileSync(pidFile, "utf8"))
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toHaveLength(1)
    // Kiframe "crashed": never closed. The next start sweeps it.
    expect(await sweepElectronOrphans(stateFile)).toBe(1)
    expect(await waitFor(() => !alive(helper))).toBe(true)
    expect(existsSync(target.sandbox)).toBe(false)
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual([])
  })

  it("says an app that quits at once, and leaves nothing behind", async () => {
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith("kiframe-app-")).length
    await expect(launch(["quit-at-once"])).rejects.toThrow(ElectronLaunchError)
    await expect(launch(["quit-at-once"])).rejects.toThrow(/quit before Kiframe could attach/)
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith("kiframe-app-")).length).toBe(before)
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
      executable: electron,
      bundle: fixture,
      args: [fixture, "hidden", `link=${secure}`, "embed-at-start", "trust-test-cert"],
      viewport,
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
    await expect(
      launchElectron({ executable: electron, bundle: "/Applications/Gone.app", viewport }),
    ).rejects.toThrow("the app isn't at /Applications/Gone.app any more")
    await expect(
      launchElectron({ executable: "/no/such/executable", viewport, timeoutMs: 5000 }),
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
      executable: electron,
      bundle: fixture,
      args: [fixture, "hidden"],
      viewport,
      signal: stop.signal,
    })
    stop.abort(new Error("stopped"))
    await expect(launching).rejects.toThrow(/stopped/)
  })
})

describe("a desktop app's own pages", () => {
  const own = {
    bundles: ["/Applications/Notes.app"],
    sandbox: "/tmp/kiframe-app-x",
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

// The state file only names sandboxes Kiframe made: never a folder from a tampered file.
describe("the launches' state file", () => {
  it("keeps a launch noted while it sweeps (only what it swept is removed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-el-state-"))
    const left = mkdtempSync(join(tmpdir(), "kiframe-app-"))
    const meanwhile = mkdtempSync(join(tmpdir(), "kiframe-app-"))
    const stateFile = join(dir, "launches.json")
    writeFileSync(stateFile, JSON.stringify([left]))
    try {
      const sweeping = sweepElectronOrphans(stateFile)
      // A run starts during the sweep: its launch is noted.
      writeFileSync(stateFile, JSON.stringify([left, meanwhile]))
      expect(await sweeping).toBe(1)
      expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual([meanwhile])
      expect(existsSync(meanwhile)).toBe(true)
    } finally {
      rmSync(left, { recursive: true, force: true })
      rmSync(meanwhile, { recursive: true, force: true })
    }
  })

  it("never sweeps a folder that isn't a sandbox (named like one, or anywhere else)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-el-state-"))
    const keep = mkdtempSync(join(tmpdir(), "users-files-"))
    // Named like a sandbox, but not one this module made (not directly in the temp folder).
    const lookalike = mkdtempSync(join(dir, "kiframe-app-"))
    const stateFile = join(dir, "launches.json")
    writeFileSync(stateFile, JSON.stringify([keep, lookalike, `${lookalike}/../..`]))
    expect(await sweepElectronOrphans(stateFile)).toBe(0)
    expect(existsSync(keep)).toBe(true)
    expect(existsSync(lookalike)).toBe(true)
  })
})
