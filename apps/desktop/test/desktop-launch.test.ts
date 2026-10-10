import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, type OpenedProject, saveProject } from "@kiframe/project"
import type { DesktopApp, ElectronLaunch, ElectronTarget, TrialOutcome } from "@kiframe/runtime"
import type { ElectronApp } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import { DesktopApprovals, opensOf } from "../src/main/desktop-apps.ts"
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
    await expect(launcher.launch("notes")).rejects.toThrow(/no longer runs confined/)
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
      await expect(launching, change).rejects.toThrow(/changed while it was checked/)
      expect(state.launches, change).toEqual([])
      expect(
        approvals.copyFor("com.example.Notes", "folder-a")?.scopes["folder-a"]?.version,
        change,
      ).not.toBe("1.1")
    }
  })

  it("tries an update once for two launches at once", async () => {
    const { launcher, state } = setup(notes({ version: "1.1" }))
    const trial = deferred<TrialOutcome>()
    state.trial = () => trial.promise
    const one = launcher.launch("notes")
    const two = launcher.launch("notes")
    await new Promise((resolve) => setTimeout(resolve, 0))
    trial.resolve({ ok: true })
    await Promise.all([one, two])
    expect(state.trials).toBe(1)
    expect(state.launches).toHaveLength(2)
  })
})
