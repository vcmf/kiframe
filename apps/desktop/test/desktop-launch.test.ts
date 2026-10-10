import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, type OpenedProject, saveProject } from "@kiframe/project"
import type { DesktopApp, ElectronLaunch, ElectronTarget, TrialOutcome } from "@kiframe/runtime"
import type { ElectronApp } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import { DesktopApprovals, opensOf } from "../src/main/desktop-apps.ts"
import { ElectronLaunchError } from "@kiframe/runtime"
import { homedir } from "node:os"
import { DesktopLauncher, DesktopRefused } from "../src/main/desktop-launch.ts"

// A desktop app launched for the agent (PR 4): from its approval only, an updated build tried
// quietly first and approved compare-and-set. Fakes for the runtime's looks and launch.

const dir = () => mkdtempSync(join(tmpdir(), "kiframe-desktop-launch-"))
const notes = (over: Partial<DesktopApp> = {}): DesktopApp => ({
  path: "/Applications/Notes.app",
  bundleId: "com.example.Notes",
  name: "Notes",
  version: "1.0",
  electron: "44.4.5",
  executable: "/Applications/Notes.app/Contents/MacOS/Notes",
  signer: { kind: "team", team: "TEAM123456", identifier: "com.example.Notes" },
  ...over,
})
const entry = (over: Partial<ElectronApp> = {}): ElectronApp => ({
  kind: "electron",
  bundleId: "com.example.Notes",
  args: ["files/vault"],
  origins: ["https://notes.example"],
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  ...over,
})

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/** A project naming the app, approved (or not) for its folder, and a launcher over fakes. */
function setup(installed: DesktopApp = notes(), approve = true) {
  const opened = createProject(join(dir(), "demo.kiframe"), {
    id: "p1",
    name: "Demo",
    url: "https://app.test",
  })
  saveProject(opened, { ...opened.project, apps: { ...opened.project.apps, notes: entry() } })
  const approvals = new DesktopApprovals(dir())
  if (approve) approvals.approve(notes(), "folder-a", opensOf(entry()))
  const state = {
    opened: opened as OpenedProject | null,
    installed,
    trials: 0,
    trial: (): Promise<TrialOutcome> => Promise.resolve({ ok: true }),
    launches: [] as ElectronLaunch[],
  }
  const launcher = new DesktopLauncher({
    approvals: () => approvals,
    looks: {
      inspect: () => Promise.resolve(state.installed),
      trial: () => {
        state.trials += 1
        return state.trial()
      },
    },
    launch: (opts) => {
      state.launches.push(opts)
      return Promise.resolve({ close: () => Promise.resolve() } as unknown as ElectronTarget)
    },
    opened: () => state.opened,
    scope: () => "folder-a",
  })
  return { launcher, state, approvals, opened }
}

describe("a desktop app launched for the agent", () => {
  it("launches the approved copy with what the project opens, its build said", async () => {
    const { launcher, state, opened } = setup()
    const { build } = await launcher.launch("notes")
    expect(state.trials).toBe(0)
    expect(state.launches[0]).toMatchObject({
      executable: "/Applications/Notes.app/Contents/MacOS/Notes",
      bundle: "/Applications/Notes.app",
      args: ["files/vault"],
      origins: ["https://notes.example"],
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    })
    // No files/ folder in the project: none given.
    expect(state.launches[0]?.files).toBeUndefined()
    expect(build).toEqual({ version: "1.0", opens: opensOf(entry()) })
    mkdirSync(join(opened.dir, "files"))
    await launcher.launch("notes")
    expect(state.launches[1]?.files).toBe(join(opened.dir, "files"))
  })

  it("refuses for the user what isn't approved here, never launching it", async () => {
    for (const [why, make] of [
      ["not added on this Mac", () => setup(notes(), false)],
      [
        "another app is there now",
        () => setup(notes({ signer: { kind: "team", team: "OTHER00000", identifier: "x" } })),
      ],
    ] as const) {
      const { launcher, state } = make()
      const error = await launcher.launch("notes").catch((e: unknown) => e)
      expect(error, why).toBeInstanceOf(DesktopRefused)
      expect((error as DesktopRefused).needsUser).toBe(true)
      expect(String(error)).toContain(why)
      expect(String(error)).toContain("in the Apps panel")
      expect(state.launches).toEqual([])
    }
    // What the project opens with it changed (a pull): asked again.
    const { launcher, state, opened } = setup()
    saveProject(opened, {
      ...opened.project,
      apps: { ...opened.project.apps, notes: entry({ origins: ["https://evil.example"] }) },
    })
    await expect(launcher.launch("notes")).rejects.toThrow(/changed what it opens/)
    expect(state.launches).toEqual([])
  })

  it("tries an update quietly, then approves that build for the project and launches it", async () => {
    const { launcher, state, approvals } = setup(notes({ version: "1.1" }))
    await launcher.launch("notes")
    expect(state.trials).toBe(1)
    expect(approvals.copyFor("com.example.Notes", "folder-a")?.scopes["folder-a"]?.version).toBe(
      "1.1",
    )
    expect(state.launches).toHaveLength(1)
    // Approved now: no second trial.
    await launcher.launch("notes")
    expect(state.trials).toBe(1)
  })

  it("refuses an update that no longer runs confined", async () => {
    const { launcher, state, approvals } = setup(notes({ version: "1.1" }))
    state.trial = () => Promise.resolve({ quit: true })
    await expect(launcher.launch("notes")).rejects.toThrow(/updated: it quit at once/)
    expect(approvals.copyFor("com.example.Notes", "folder-a")?.scopes["folder-a"]?.version).toBe(
      "1.0",
    )
    expect(state.launches).toEqual([])
  })

  it("never approves what changed while the update was tried (removed, project switched)", async () => {
    for (const change of ["removed", "switched"] as const) {
      const { launcher, state, approvals } = setup(notes({ version: "1.1" }))
      const trial = deferred<TrialOutcome>()
      state.trial = () => trial.promise
      const launching = launcher.launch("notes")
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (change === "removed") approvals.drop("com.example.Notes", "folder-a")
      else state.opened = null
      trial.resolve({ ok: true })
      await expect(launching, change).rejects.toThrow(/changed meanwhile/)
      expect(state.launches, change).toEqual([])
      expect(
        approvals.copyFor("com.example.Notes", "folder-a")?.scopes["folder-a"]?.version,
        change,
      ).not.toBe("1.1")
    }
  })

  it("lets two launches of an update at once each try it, both approving the same build", async () => {
    const { launcher, state, approvals } = setup(notes({ version: "1.1" }))
    await Promise.all([launcher.launch("notes"), launcher.launch("notes")])
    expect(state.trials).toBe(2)
    expect(state.launches).toHaveLength(2)
    expect(approvals.copyFor("com.example.Notes", "folder-a")?.scopes["folder-a"]?.version).toBe(
      "1.1",
    )
  })

  it("never launches an app removed or a project switched while it was looked at", async () => {
    for (const change of ["removed", "closed", "another"] as const) {
      const { state, approvals } = setup()
      const looking = deferred<DesktopApp>()
      const launcher = new DesktopLauncher({
        approvals: () => approvals,
        looks: { inspect: () => looking.promise, trial: () => Promise.resolve({ ok: true }) },
        launch: (opts) => {
          state.launches.push(opts)
          return Promise.resolve({ close: () => Promise.resolve() } as unknown as ElectronTarget)
        },
        opened: () => state.opened,
        scope: () => "folder-a",
      })
      const launching = launcher.launch("notes")
      if (change === "removed") approvals.drop("com.example.Notes", "folder-a")
      if (change === "closed") state.opened = null
      // Another project naming the app the same, opened meanwhile (same scope: never its approval).
      if (change === "another") state.opened = setup().opened
      looking.resolve(notes())
      await expect(launching, change).rejects.toThrow(/changed meanwhile/)
      expect(state.launches, change).toEqual([])
    }
  })

  it("ends a quiet trial with the launcher (a project switch, a quit), and never starts one stopped", async () => {
    const { launcher, state } = setup(notes({ version: "1.1" }))
    let signal: AbortSignal | undefined
    const trialing = new DesktopLauncher({
      approvals: () => setup().approvals,
      looks: {
        inspect: () => Promise.resolve(notes({ version: "1.1" })),
        trial: (_app, o) => {
          signal = o.signal
          // As the runtime's: a stop thrown as the stop.
          return new Promise<TrialOutcome>((_, reject) =>
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason as Error)),
          )
        },
      },
      launch: () => Promise.reject(new Error("never")),
      opened: () => state.opened,
      scope: () => "folder-a",
    })
    const launching = trialing.launch("notes")
    await new Promise((resolve) => setTimeout(resolve, 0))
    trialing.stopAll()
    // Refused for the user (never a raw stop the agent takes for its own).
    const error = await launching.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopRefused)
    expect(String(error)).toMatch(/the project closed while it was checked/)
    expect(signal?.aborted).toBe(true)
    // A launch already stopped: no trial at all.
    const stopped = new AbortController()
    stopped.abort()
    const before = state.trials
    await expect(launcher.launch("notes", stopped.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(state.trials).toBe(before)
  })

  it("never launches a build other than the one tried (an update landing during its trial)", async () => {
    const { launcher, state } = setup(notes({ version: "1.1" }))
    const trial = deferred<TrialOutcome>()
    state.trial = () => trial.promise
    const launching = launcher.launch("notes")
    await new Promise((resolve) => setTimeout(resolve, 0))
    state.installed = notes({ version: "1.2" })
    trial.resolve({ ok: true })
    await expect(launching).rejects.toThrow(/updated again while it was checked/)
    expect(state.launches).toEqual([])
  })

  it("stops only the launch that was stopped (its own trial), never another's", async () => {
    const { state, approvals } = setup(notes({ version: "1.1" }))
    const launcher = new DesktopLauncher({
      approvals: () => approvals,
      looks: {
        inspect: () => Promise.resolve(state.installed),
        trial: (_app, o) =>
          new Promise<TrialOutcome>((resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason as Error))
            setTimeout(() => resolve({ ok: true }), 20)
          }),
      },
      launch: (opts) => {
        state.launches.push(opts)
        return Promise.resolve({ close: () => Promise.resolve() } as unknown as ElectronTarget)
      },
      opened: () => state.opened,
      scope: () => "folder-a",
    })
    const stopping = new AbortController()
    const stopped = launcher.launch("notes", stopping.signal)
    const going = launcher.launch("notes")
    await new Promise((resolve) => setTimeout(resolve, 0))
    stopping.abort()
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" })
    await going
    expect(state.launches).toHaveLength(1)
  })

  it("says why an update's quiet trial didn't work, and a failed approval, for the user", async () => {
    for (const [outcome, said] of [
      [{ site: "https://login.example" }, /its window is now the site https:\/\/login\.example/],
      [{ quit: true }, /quit at once/],
      [{ failed: "busy" }, /couldn't be tried confined \(busy\)/],
    ] as const) {
      const { launcher, state } = setup(notes({ version: "1.1" }))
      state.trial = () => Promise.resolve(outcome as TrialOutcome)
      const error = await launcher.launch("notes").catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DesktopRefused)
      expect(String(error)).toMatch(said)
    }
    const { state, approvals } = setup(notes({ version: "1.1" }))
    const failing = new DesktopLauncher({
      approvals: () =>
        Object.assign(Object.create(approvals) as DesktopApprovals, {
          copyFor: approvals.copyFor.bind(approvals),
          approve: () => {
            // As a write fails: its message names the approvals file.
            throw Object.assign(new Error("EACCES: permission denied, open '/Users/a/x.json'"), {
              code: "EACCES",
            })
          },
        }),
      looks: {
        inspect: () => Promise.resolve(state.installed),
        trial: () => Promise.resolve({ ok: true }),
      },
      launch: () => Promise.reject(new Error("never")),
      opened: () => state.opened,
      scope: () => "folder-a",
    })
    const error = await failing.launch("notes").catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DesktopRefused)
    expect(String(error)).toMatch(/couldn't be approved here \(EACCES\)/)
    expect(String(error)).not.toContain("/Users")
  })

  it("never approves an update for another project opened while it was tried", async () => {
    const { launcher, state, approvals } = setup(notes({ version: "1.1" }))
    const trial = deferred<TrialOutcome>()
    state.trial = () => trial.promise
    const launching = launcher.launch("notes")
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Another project naming the app the same (same scope), opened during the trial.
    state.opened = setup().opened
    trial.resolve({ ok: true })
    await expect(launching).rejects.toThrow(/changed meanwhile/)
    expect(approvals.copyFor("com.example.Notes", "folder-a")?.scopes["folder-a"]?.version).toBe(
      "1.0",
    )
    expect(state.launches).toEqual([])
  })

  it("launches only the build approved now (another launch's approval meanwhile: refused)", async () => {
    const { state, approvals } = setup()
    const looking = deferred<DesktopApp>()
    const launcher = new DesktopLauncher({
      approvals: () => approvals,
      looks: { inspect: () => looking.promise, trial: () => Promise.resolve({ ok: true }) },
      launch: (opts) => {
        state.launches.push(opts)
        return Promise.resolve({ close: () => Promise.resolve() } as unknown as ElectronTarget)
      },
      opened: () => state.opened,
      scope: () => "folder-a",
    })
    const launching = launcher.launch("notes")
    // Another launch approved 1.1 meanwhile: this one's 1.0 is no longer the approved build.
    approvals.approve(notes({ version: "1.1" }), "folder-a", opensOf(entry()))
    looking.resolve(notes())
    await expect(launching).rejects.toThrow(/changed meanwhile/)
    expect(state.launches).toEqual([])
  })

  it("says every launch failure for the user, never a local path", async () => {
    const failing = (error: Error) => {
      const { state, approvals } = setup()
      return new DesktopLauncher({
        approvals: () => approvals,
        looks: {
          inspect: () => Promise.resolve(state.installed),
          trial: () => Promise.resolve({ ok: true }),
        },
        launch: () => Promise.reject(error),
        opened: () => state.opened,
        scope: () => "folder-a",
      })
    }
    // An OS error (its message names a path): said by its code only.
    const os = Object.assign(new Error("spawn /Users/alice/Apps/My App.app/x ENOENT"), {
      code: "ENOENT",
    })
    const fromOs = await failing(os)
      .launch("notes")
      .catch((e: unknown) => e)
    expect(fromOs).toBeInstanceOf(DesktopRefused)
    expect(String(fromOs)).toContain("notes couldn't be launched (ENOENT)")
    expect(String(fromOs)).not.toContain("/Users")
    // The runtime's own launch errors (worded, path-free): as they are.
    const said = await failing(new ElectronLaunchError("the app quit before Kiframe could attach"))
      .launch("notes")
      .catch((e: unknown) => e)
    expect(String(said)).toContain("notes couldn't be launched: the app quit before")
    expect((said as DesktopRefused).needsUser).toBe(true)
    // A message naming a folder Kiframe knows (never meant to): replaced whole.
    const leaked = await failing(new ElectronLaunchError(`odd: ${homedir()}/x`))
      .launch("notes")
      .catch((e: unknown) => e)
    expect(String(leaked)).not.toContain(homedir())
    expect(String(leaked)).toContain("details kept out")
  })
})
