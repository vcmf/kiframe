import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, openProject, saveProject } from "@kiframe/project"
import type { DesktopApp, TrialOptions, TrialOutcome } from "@kiframe/runtime"
import type { ElectronApp } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import { Workspace } from "../src/main/workspace.ts"
import {
  addHostOf,
  type AddHost,
  appNameFor,
  DesktopAdds,
  DesktopApprovals,
  desktopStatus,
  opensOf,
} from "../src/main/desktop-apps.ts"

// Desktop apps added and approved (PR 3b): main's store, status and add flow, with the runtime's
// inspection and trial as fakes (nothing launches here; the runtime's own tests launch for real).

const dir = () => mkdtempSync(join(tmpdir(), "kiframe-desktop-apps-"))
const project = () =>
  createProject(join(dir(), "demo.kiframe"), { id: "p1", name: "Demo", url: "https://app.test" })

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

/** Fakes of the runtime's looks: what's at each path, what a trial says (recorded). */
const looks = (
  apps: Record<string, DesktopApp>,
  outcome: (o: TrialOptions) => TrialOutcome = () => ({ ok: true }),
) => {
  const trials: TrialOptions[] = []
  return {
    trials,
    looks: {
      inspect: (path: string, _signal?: AbortSignal) => {
        const app = apps[path]
        return app === undefined
          ? Promise.reject(new Error("that app can't be read (moved or removed?)"))
          : Promise.resolve(app)
      },
      trial: (_app: DesktopApp, o: TrialOptions) => {
        trials.push(o)
        return Promise.resolve(outcome(o))
      },
    },
  }
}

const entry = (over: Partial<ElectronApp> = {}): ElectronApp => ({
  kind: "electron",
  bundleId: "com.example.Notes",
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  ...over,
})

describe("a desktop app's approvals", () => {
  it("are kept per Mac and per project, with what the project opens", () => {
    const data = dir()
    const approvals = new DesktopApprovals(data)
    approvals.approve(notes(), "folder-a", opensOf(entry()))
    const again = new DesktopApprovals(data)
    // With the build this project tried.
    expect(again.copyFor("COM.EXAMPLE.NOTES", "folder-a")?.scopes).toEqual({
      "folder-a": { opens: opensOf(entry()), version: "1.0" },
    })
    expect(readFileSync(join(data, "desktop-apps.json")).length).toBeGreaterThan(0)
    again.drop("com.example.Notes", "folder-a")
    expect(new DesktopApprovals(data).copies("com.example.Notes")).toEqual([])
  })

  it("keep other projects' approvals for the same app, drop them for another build there", () => {
    const approvals = new DesktopApprovals(dir())
    const scopes = () => approvals.copies("com.example.Notes").map((c) => Object.keys(c.scopes))
    approvals.approve(notes(), "folder-a", "a".repeat(64))
    // An update of the same developer's app: still theirs.
    approvals.approve(notes({ version: "1.1" }), "folder-b", "b".repeat(64))
    expect(scopes()).toEqual([["folder-a", "folder-b"]])
    // Another developer at that place now: the others approved that one, not this.
    approvals.approve(
      notes({ signer: { kind: "team", team: "OTHER00000", identifier: "x" } }),
      "folder-b",
      "b".repeat(64),
    )
    expect(scopes()).toEqual([["folder-b"]])
  })

  it("keep each copy of an app apart (a release and a dev build of one id)", () => {
    const approvals = new DesktopApprovals(dir())
    const release = notes()
    const dev = notes({
      path: "/Users/me/dev/Notes.app",
      signer: { kind: "pinned", digest: "c".repeat(64) },
    })
    approvals.approve(release, "folder-a", "a".repeat(64))
    approvals.approve(dev, "folder-b", "b".repeat(64))
    // Each project keeps its own copy (never taken from the other).
    expect(approvals.copyFor("com.example.Notes", "folder-a")?.path).toBe(release.path)
    expect(approvals.copyFor("com.example.Notes", "folder-b")?.path).toBe(dev.path)
    // A project switching copies lets the other go.
    approvals.approve(dev, "folder-a", "a".repeat(64))
    expect(approvals.copies("com.example.Notes").map((c) => c.path)).toEqual([dev.path])
  })

  it("always read back (copies capped, long names cut): never set aside for what they wrote", () => {
    const data = dir()
    const approvals = new DesktopApprovals(data)
    for (let i = 0; i < 25; i++) {
      approvals.approve(
        notes({
          path: `/Users/me/dev/w${i}/Notes.app`,
          name: "N".repeat(300),
          version: "9".repeat(150),
        }),
        `folder-${i}`,
        opensOf(entry()),
      )
    }
    const again = new DesktopApprovals(data)
    expect(again.takeProblem()).toBeNull()
    expect(again.copies("com.example.Notes")).toHaveLength(20)
    expect(again.copyFor("com.example.Notes", "folder-24")?.name).toHaveLength(200)
    // A long version compares as it was kept (never "updated" for being long).
    const team = notes({ path: "/Users/me/dev/w24/Notes.app", version: "9".repeat(150) })
    return desktopStatus(entry(), "folder-24", again, looks({ [team.path]: team }).looks).then(
      (status) => expect(status).toMatchObject({ status: "ready" }),
    )
  })

  it("change nothing when a write fails (memory as on disk)", () => {
    const data = dir()
    const approvals = new DesktopApprovals(data)
    approvals.approve(notes(), "folder-a", "a".repeat(64))
    chmodSync(data, 0o500)
    try {
      expect(() => approvals.approve(notes(), "folder-b", "b".repeat(64))).toThrow()
      expect(approvals.copyFor("com.example.Notes", "folder-b")).toBeUndefined()
    } finally {
      chmodSync(data, 0o700)
    }
  })

  it("set a file that doesn't read aside, never overwrite it", () => {
    const data = dir()
    writeFileSync(join(data, "desktop-apps.json"), "{ not json")
    const approvals = new DesktopApprovals(data)
    expect(approvals.takeProblem()).toMatch(/set aside as .*desktop-apps\.json\.bad-\d+/)
    expect(readdirSync(data).some((n) => n.startsWith("desktop-apps.json.bad-"))).toBe(true)
    approvals.approve(notes(), "folder-a", "a".repeat(64))
    const aside = readdirSync(data).find((n) => n.startsWith("desktop-apps.json.bad-"))
    expect(readFileSync(join(data, aside ?? ""), "utf8")).toBe("{ not json")
  })
})

describe("a desktop app's status (static: nothing launches)", () => {
  const status = async (
    at: Record<string, DesktopApp>,
    approve: ((a: DesktopApprovals) => void) | undefined,
    app = entry(),
  ) => {
    const approvals = new DesktopApprovals(dir())
    approve?.(approvals)
    return desktopStatus(app, "folder-a", approvals, looks(at).looks)
  }
  const approved = (a: DesktopApprovals) => a.approve(notes(), "folder-a", opensOf(entry()))

  it("is ready when approved here for what it opens, updated when its developer shipped a new build", async () => {
    // With the app as inspected now, at the approved copy's place (what a launch starts).
    expect(await status({ "/Applications/Notes.app": notes() }, approved)).toEqual({
      status: "ready",
      app: notes(),
    })
    expect(
      await status({ "/Applications/Notes.app": notes({ version: "2.0" }) }, approved),
    ).toEqual({ status: "updated", app: notes({ version: "2.0" }) })
  })

  it("asks again: never added here, another project's, what it opens changed", async () => {
    const at = { "/Applications/Notes.app": notes() }
    expect((await status(at, undefined)).status).toBe("allow")
    expect((await status(at, (a) => a.approve(notes(), "folder-b", opensOf(entry())))).status).toBe(
      "allow",
    )
    // A pull added a site the project shows as the app's own (or an argument): asked again.
    const opens = entry({ origins: ["https://evil.example"] })
    expect((await status(at, approved, opens)).status).toBe("opens-changed")
  })

  it("keeps each project's tried build: another's approval of an update changes nothing here", async () => {
    const approvals = new DesktopApprovals(dir())
    approvals.approve(notes(), "folder-b", opensOf(entry()))
    const updated = { "/Applications/Notes.app": notes({ version: "1.1" }) }
    expect(await desktopStatus(entry(), "folder-b", approvals, looks(updated).looks)).toMatchObject(
      { status: "updated" },
    )
    // Project A tries and approves 1.1: B still hasn't tried it.
    approvals.approve(notes({ version: "1.1" }), "folder-a", opensOf(entry()))
    expect(await desktopStatus(entry(), "folder-b", approvals, looks(updated).looks)).toMatchObject(
      { status: "updated" },
    )
    expect(await desktopStatus(entry(), "folder-a", approvals, looks(updated).looks)).toMatchObject(
      { status: "ready" },
    )
  })

  it("never looks at the app to say what needs no look (another project's, opens changed)", async () => {
    const approvals = new DesktopApprovals(dir())
    approvals.approve(notes(), "folder-b", opensOf(entry()))
    const never = {
      inspect: () => Promise.reject(new Error("looked at the app")),
    }
    expect((await desktopStatus(entry(), "folder-a", approvals, never)).status).toBe("allow")
    approvals.approve(notes(), "folder-a", opensOf(entry()))
    const opens = entry({ origins: ["https://evil.example"] })
    expect((await desktopStatus(opens, "folder-a", approvals, never)).status).toBe("opens-changed")
  })

  it("is changed for another developer or another unsigned build, not found when gone", async () => {
    const other = notes({
      signer: { kind: "team", team: "OTHER00000", identifier: "com.example.Notes" },
    })
    expect((await status({ "/Applications/Notes.app": other }, approved)).status).toBe("changed")
    const pinned = notes({ signer: { kind: "pinned", digest: "a".repeat(64) } })
    const rebuilt = notes({ signer: { kind: "pinned", digest: "b".repeat(64) } })
    const approvePinned = (a: DesktopApprovals) => a.approve(pinned, "folder-a", opensOf(entry()))
    expect((await status({ "/Applications/Notes.app": pinned }, approvePinned)).status).toBe(
      "ready",
    )
    expect((await status({ "/Applications/Notes.app": rebuilt }, approvePinned)).status).toBe(
      "changed",
    )
    expect((await status({}, approved)).status).toBe("not-found")
  })
})

/** A deferred answer (a wait the test lets go of when it wants). */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

/**
 * The add flow with a fake host: the open project, its session, Kif's state and the picker driven
 * by the test; what's approved and told recorded.
 */
function harness(
  opened = project(),
  at: Record<string, DesktopApp> = { "/Applications/Notes.app": notes() },
  outcome: (o: TrialOptions) => TrialOutcome = () => ({ ok: true }),
) {
  const state = {
    session: "s1" as string | undefined,
    opened: opened as ReturnType<typeof project> | null,
    busy: undefined as string | undefined,
    picked: "/Applications/Notes.app" as string | undefined,
    approved: [] as string[],
    changed: 0,
  }
  const fake = looks(at, outcome)
  const approvals = new DesktopApprovals(dir())
  const host: AddHost = {
    session: () => state.session,
    opened: () => state.opened,
    busy: () => state.busy,
    pickApp: () => Promise.resolve(state.picked),
    approve: (app, o, opens) => {
      approvals.approve(app, "folder-a", opens)
      state.approved.push(app.bundleId)
      void o
    },
    changed: () => (state.changed += 1),
  }
  const adds = new DesktopAdds(fake.looks, host)
  const pick = async () => {
    const card = await adds.pick(1, "s1")
    if (card === null) throw new Error("no card")
    return card
  }
  return { adds, state, host, fake, approvals, opened, pick }
}

describe("adding a desktop app", () => {
  it("adds it once it ran confined: named, written to the project, approved here", async () => {
    const h = harness()
    const card = await h.pick()
    expect(card).toMatchObject({
      name: "Notes",
      bundleId: "com.example.Notes",
      signer: { kind: "team", team: "TEAM123456" },
    })
    expect(JSON.stringify(card)).not.toContain("/Applications")
    await expect(h.adds.add(1, "s1", card.token)).rejects.toThrow(/check it first/)
    expect(await h.adds.check(1, "s1", card.token, false)).toEqual({ ok: true })
    expect(await h.adds.add(1, "s1", card.token)).toBe("notes")
    expect(openProject(h.opened.dir).project.apps["notes"]).toMatchObject({
      kind: "electron",
      bundleId: "com.example.Notes",
    })
    expect(h.state.changed).toBe(1)
    expect(
      await desktopStatus(
        h.opened.project.apps["notes"] as ElectronApp,
        "folder-a",
        h.approvals,
        h.fake.looks,
      ),
    ).toMatchObject({ status: "ready" })
  })

  it("allows a wrapper's site only as the trial named it, tried before it's added", async () => {
    const h = harness(project(), undefined, (o) =>
      (o.origins ?? []).length > 0 ? { ok: true } : { site: "https://app.slack.com" },
    )
    const card = await h.pick()
    await expect(h.adds.check(1, "s1", card.token, true)).rejects.toThrow(/no site to allow/)
    expect(await h.adds.check(1, "s1", card.token, false)).toEqual({
      site: "https://app.slack.com",
    })
    expect(await h.adds.check(1, "s1", card.token, true)).toEqual({ ok: true })
    expect(h.fake.trials.at(-1)?.origins).toEqual(["https://app.slack.com"])
    await h.adds.add(1, "s1", card.token)
    expect(openProject(h.opened.dir).project.apps["notes"]).toMatchObject({
      origins: ["https://app.slack.com"],
    })
  })

  it("never adds while a check runs (a site allowed but not tried yet)", async () => {
    const trial = deferred<TrialOutcome>()
    let first = true
    const h = harness()
    h.fake.looks.trial = (_app, o) => {
      h.fake.trials.push(o)
      if (first) {
        first = false
        return Promise.resolve({ site: "https://app.slack.com" })
      }
      return trial.promise
    }
    const card = await h.pick()
    await h.adds.check(1, "s1", card.token, false)
    const checking = h.adds.check(1, "s1", card.token, true)
    await expect(h.adds.add(1, "s1", card.token)).rejects.toThrow(/being checked/)
    trial.resolve({ ok: true })
    await checking
    expect(await h.adds.add(1, "s1", card.token)).toBe("notes")
  })

  it("refuses a token of another window or project, and a build changed since its trial", async () => {
    const h = harness()
    const card = await h.pick()
    await expect(h.adds.check(2, "s1", card.token, false)).rejects.toThrow(
      /isn't being added any more/,
    )
    await expect(h.adds.check(1, "s2", card.token, false)).rejects.toThrow(
      /isn't being added any more/,
    )
    await h.adds.check(1, "s1", card.token, false)
    h.fake.looks.inspect = () =>
      Promise.resolve(notes({ signer: { kind: "team", team: "OTHER00000", identifier: "x" } }))
    await expect(h.adds.add(1, "s1", card.token)).rejects.toThrow(/changed since it was checked/)
  })

  it("says a file changed on disk as itself, and a site the project can't take in words", async () => {
    const h = harness()
    const card = await h.pick()
    await h.adds.check(1, "s1", card.token, false)
    writeFileSync(
      join(h.opened.dir, "project.json"),
      readFileSync(join(h.opened.dir, "project.json"), "utf8") + " ",
    )
    await expect(h.adds.add(1, "s1", card.token)).rejects.toThrow(/changed on disk.*reopen it/)
    // The site is a web app's of the project already (one app per site).
    const opened = project()
    saveProject(opened, { ...opened.project, apps: { ...opened.project.apps, desk: entry() } })
    const g = harness(opened, undefined, (o) =>
      (o.origins ?? []).length > 0 ? { ok: true } : { site: "https://app.test" },
    )
    const named = await g.pick()
    await g.adds.check(1, "s1", named.token, false)
    await g.adds.check(1, "s1", named.token, true)
    const error = await g.adds.add(1, "s1", named.token).then(
      () => "",
      (e: unknown) => (e as Error).message,
    )
    expect(error).toMatch(/^the project can't take it so/)
    expect(error).not.toMatch(/"code"|\[\{/)
  })

  it("approves the build that was tried (one updated since: updated, never ready)", async () => {
    const h = harness()
    const card = await h.pick()
    await h.adds.check(1, "s1", card.token, false)
    // The developer's update lands between the check and the add.
    h.fake.looks.inspect = () => Promise.resolve(notes({ version: "2.0" }))
    await h.adds.add(1, "s1", card.token)
    const desk = openProject(h.opened.dir).project.apps["notes"] as ElectronApp
    expect(await desktopStatus(desk, "folder-a", h.approvals, h.fake.looks)).toMatchObject({
      status: "updated",
    })
  })

  it("stops looking at an app picked then given up", async () => {
    const h = harness()
    let signal: AbortSignal | undefined
    h.fake.looks.inspect = (_path, s) => {
      signal = s
      return new Promise<DesktopApp>((_, reject) =>
        s?.addEventListener("abort", () => reject(s.reason as Error)),
      )
    }
    const picking = h.adds.pick(1, "s1")
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.adds.dropFor(1)
    expect(await picking).toBeNull()
    expect(signal?.aborted).toBe(true)
  })

  it("stops looking at the app again when its add is given up", async () => {
    const h = harness()
    const card = await h.pick()
    await h.adds.check(1, "s1", card.token, false)
    let signal: AbortSignal | undefined
    h.fake.looks.inspect = (_path, s) => {
      signal = s
      return new Promise<DesktopApp>((_, reject) =>
        s?.addEventListener("abort", () => reject(s.reason as Error)),
      )
    }
    const adding = h.adds.add(1, "s1", card.token)
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.adds.dropFor(1)
    await expect(adding).rejects.toThrow(/isn't being added any more/)
    expect(signal?.aborted).toBe(true)
  })

  it("is done once written: an approval that fails then is said, never added twice", async () => {
    const h = harness()
    h.host.approve = () => {
      throw new Error("EACCES")
    }
    const card = await h.pick()
    await h.adds.check(1, "s1", card.token, false)
    await expect(h.adds.add(1, "s1", card.token)).rejects.toThrow(
      /added as notes, but not approved on this Mac/,
    )
    await expect(h.adds.add(1, "s1", card.token)).rejects.toThrow(/isn't being added any more/)
    expect(Object.keys(openProject(h.opened.dir).project.apps)).toEqual(["app", "notes"])
  })
})

describe("an app's name in the project", () => {
  it("is its own name in the app-name form, made unique; nothing left: app", () => {
    expect(appNameFor("Visual Studio Code", [])).toBe("visual-studio-code")
    expect(appNameFor("Slack", ["slack"])).toBe("slack-2")
    expect(appNameFor("微信", [])).toBe("app")
    expect(appNameFor("1Password", [])).toBe("password")
  })
})

describe("adding an app a project already names", () => {
  const named = () => {
    const opened = project()
    saveProject(opened, {
      ...opened.project,
      apps: {
        ...opened.project.apps,
        desk: entry({ args: ["files/vault"], origins: ["https://a.example"] }),
      },
    })
    return opened
  }

  it("shows what it opens, tries it with its sites, and approves it without adding it twice", async () => {
    const h = harness(named())
    const card = await h.pick()
    expect(card.existing).toBe("desk")
    expect(card.opens).toEqual({ args: ["files/vault"], origins: ["https://a.example"] })
    await h.adds.check(1, "s1", card.token, false)
    expect(h.fake.trials[0]?.origins).toEqual(["https://a.example"])
    expect(await h.adds.add(1, "s1", card.token)).toBe("desk")
    expect(Object.keys(openProject(h.opened.dir).project.apps)).toEqual(["app", "desk"])
    expect(h.approvals.copyFor("com.example.Notes", "folder-a")?.scopes["folder-a"]?.opens).toBe(
      opensOf(entry({ args: ["files/vault"], origins: ["https://a.example"] })),
    )
  })

  it("never approves a project changed since the pick", async () => {
    const h = harness(named())
    const card = await h.pick()
    await h.adds.check(1, "s1", card.token, false)
    const desk = h.opened.project.apps["desk"] as ElectronApp
    saveProject(h.opened, {
      ...h.opened.project,
      apps: {
        ...h.opened.project.apps,
        desk: { ...desk, origins: ["https://a.example", "https://evil.example"] },
      },
    })
    await expect(h.adds.add(1, "s1", card.token)).rejects.toThrow(/the project changed meanwhile/)
  })

  it("writes a site allowed in its check to the project, and approves that", async () => {
    const opened = project()
    saveProject(opened, { ...opened.project, apps: { ...opened.project.apps, desk: entry() } })
    const h = harness(opened, undefined, (o) =>
      (o.origins ?? []).length > 0 ? { ok: true } : { site: "https://app.slack.com" },
    )
    const card = await h.pick()
    await h.adds.check(1, "s1", card.token, false)
    await h.adds.check(1, "s1", card.token, true)
    expect(await h.adds.add(1, "s1", card.token)).toBe("desk")
    const desk = openProject(opened.dir).project.apps["desk"] as ElectronApp
    expect(desk.origins).toEqual(["https://app.slack.com"])
    expect(await desktopStatus(desk, "folder-a", h.approvals, h.fake.looks)).toMatchObject({
      status: "ready",
    })
  })
})

describe("an add's lifetime: its project's, checked after every wait", () => {
  it("drops a pick whose project changed or that was cancelled while the user picked", async () => {
    const h = harness()
    const dialog = deferred<string | undefined>()
    h.host.pickApp = () => dialog.promise
    const picking = h.adds.pick(1, "s1")
    await expect(h.adds.pick(1, "s1")).rejects.toThrow(/being picked already/)
    h.adds.dropFor(1)
    dialog.resolve("/Applications/Notes.app")
    expect(await picking).toBeNull()
    // And the next pick works (nothing left stuck).
    h.host.pickApp = () => Promise.resolve("/Applications/Notes.app")
    expect(await h.adds.pick(1, "s1")).not.toBeNull()
    // A project switch while the app is looked at: no card.
    const inspecting = deferred<DesktopApp>()
    h.fake.looks.inspect = () => inspecting.promise
    const later = h.adds.pick(1, "s1")
    h.state.session = "s2"
    inspecting.resolve(notes())
    expect(await later).toBeNull()
  })

  it("never writes an add given up, or Kif started, while the app was looked at again", async () => {
    for (const giveUp of ["switch", "cancel", "busy"] as const) {
      const h = harness()
      const card = await h.pick()
      await h.adds.check(1, "s1", card.token, false)
      const inspecting = deferred<DesktopApp>()
      h.fake.looks.inspect = () => inspecting.promise
      const adding = h.adds.add(1, "s1", card.token)
      if (giveUp === "switch") h.state.session = "s2"
      if (giveUp === "cancel") h.adds.dropFor(1)
      if (giveUp === "busy") h.state.busy = "Kif is working: stop it first"
      inspecting.resolve(notes())
      await expect(adding, giveUp).rejects.toThrow(
        giveUp === "busy" ? /Kif is working/ : /isn't being added any more/,
      )
      expect(openProject(h.opened.dir).project.apps["notes"], giveUp).toBeUndefined()
      expect(h.state.approved, giveUp).toEqual([])
    }
  })

  it("reads the project after the pick (an app removed meanwhile is no longer 'named')", async () => {
    const opened = project()
    saveProject(opened, { ...opened.project, apps: { ...opened.project.apps, desk: entry() } })
    const h = harness(opened)
    const dialog = deferred<string | undefined>()
    h.host.pickApp = () => dialog.promise
    const picking = h.adds.pick(1, "s1")
    const { desk: _desk, ...rest } = opened.project.apps
    void _desk
    saveProject(opened, { ...opened.project, apps: rest })
    dialog.resolve("/Applications/Notes.app")
    expect((await picking)?.existing).toBeUndefined()
  })

  it("ends every add and its trial as the workspace switches project", async () => {
    const workspace = new Workspace(() => ({ close: () => Promise.resolve(), running: false }))
    await workspace.open(project().dir)
    let signal: AbortSignal | undefined
    const host = addHostOf(workspace, {
      pickApp: () => Promise.resolve("/Applications/Notes.app"),
      approve: () => undefined,
      changed: () => undefined,
    })
    const adds: DesktopAdds = new DesktopAdds(
      {
        inspect: () => Promise.resolve(notes()),
        trial: (_app, o) => {
          signal = o.signal
          return new Promise<TrialOutcome>((_, reject) =>
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason as Error)),
          )
        },
      },
      host,
    )
    workspace.onSwitch(() => adds.dropAll())
    const session = workspace.session ?? ""
    const card = await adds.pick(1, session)
    const checking = adds.check(1, session, card?.token ?? "", false)
    await workspace.close()
    await expect(checking).rejects.toMatchObject({ name: "AbortError" })
    expect(signal?.aborted).toBe(true)
    expect(workspace.session).toBeUndefined()
  })
})
