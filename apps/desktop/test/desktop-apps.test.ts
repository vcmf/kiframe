import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, openProject, saveProject } from "@kiframe/project"
import type { DesktopApp, TrialOptions, TrialOutcome } from "@kiframe/runtime"
import type { ElectronApp } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import {
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
      inspect: (path: string) => {
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
    expect(again.get("COM.EXAMPLE.NOTES")?.scopes).toEqual({
      "folder-a": { opens: opensOf(entry()) },
    })
    expect(readFileSync(join(data, "desktop-apps.json")).length).toBeGreaterThan(0)
    again.drop("com.example.Notes", "folder-a")
    expect(new DesktopApprovals(data).get("com.example.Notes")?.scopes).toEqual({})
  })

  it("keep other projects' approvals for the same app, drop them for another build", () => {
    const approvals = new DesktopApprovals(dir())
    approvals.approve(notes(), "folder-a", "a".repeat(64))
    // An update of the same developer's app: still theirs.
    approvals.approve(notes({ version: "1.1" }), "folder-b", "b".repeat(64))
    expect(Object.keys(approvals.get("com.example.Notes")?.scopes ?? {})).toEqual([
      "folder-a",
      "folder-b",
    ])
    // Another developer (or another place): the others approved that one, not this.
    approvals.approve(
      notes({ signer: { kind: "team", team: "OTHER00000", identifier: "x" } }),
      "folder-b",
      "b".repeat(64),
    )
    expect(Object.keys(approvals.get("com.example.Notes")?.scopes ?? {})).toEqual(["folder-b"])
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
    expect(await status({ "/Applications/Notes.app": notes() }, approved)).toEqual({
      status: "ready",
    })
    expect(
      await status({ "/Applications/Notes.app": notes({ version: "2.0" }) }, approved),
    ).toEqual({
      status: "updated",
    })
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

describe("adding a desktop app", () => {
  const at = { "/Applications/Notes.app": notes() }

  it("adds it once it ran confined: named, written to the project, approved here", async () => {
    const opened = project()
    const approvals = new DesktopApprovals(dir())
    const adds = new DesktopAdds(looks(at).looks, () => "s1")
    const card = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    expect(card).toMatchObject({
      name: "Notes",
      bundleId: "com.example.Notes",
      signer: { kind: "team", team: "TEAM123456" },
    })
    expect(JSON.stringify(card)).not.toContain("/Applications")
    // Never before a trial worked.
    await expect(adds.add(1, "s1", card.token, opened, "folder-a", approvals)).rejects.toThrow(
      /check it first/,
    )
    expect(await adds.check(1, "s1", card.token, false)).toEqual({ ok: true })
    expect(await adds.add(1, "s1", card.token, opened, "folder-a", approvals)).toBe("notes")
    expect(openProject(opened.dir).project.apps["notes"]).toMatchObject({
      kind: "electron",
      bundleId: "com.example.Notes",
    })
    expect(
      await desktopStatus(
        opened.project.apps["notes"] as ElectronApp,
        "folder-a",
        approvals,
        looks(at).looks,
      ),
    ).toEqual({ status: "ready" })
  })

  it("allows a wrapper's site only as the trial named it (never one the window names)", async () => {
    const opened = project()
    const fake = looks(at, (o) =>
      (o.origins ?? []).length > 0 ? { ok: true } : { site: "https://app.slack.com" },
    )
    const adds = new DesktopAdds(fake.looks, () => "s1")
    const card = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    await expect(adds.check(1, "s1", card.token, true)).rejects.toThrow(/no site to allow/)
    expect(await adds.check(1, "s1", card.token, false)).toEqual({ site: "https://app.slack.com" })
    expect(await adds.check(1, "s1", card.token, true)).toEqual({ ok: true })
    expect(fake.trials.at(-1)?.origins).toEqual(["https://app.slack.com"])
    await adds.add(1, "s1", card.token, opened, "folder-a", new DesktopApprovals(dir()))
    expect(openProject(opened.dir).project.apps["notes"]).toMatchObject({
      origins: ["https://app.slack.com"],
    })
  })

  it("approves an app the project already names, without adding it twice", async () => {
    const opened = project()
    saveProject(opened, {
      ...opened.project,
      apps: { ...opened.project.apps, desk: entry({ origins: ["https://a.example"] }) },
    })
    const approvals = new DesktopApprovals(dir())
    const fake = looks(at)
    const adds = new DesktopAdds(fake.looks, () => "s1")
    const card = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    expect(card.existing).toBe("desk")
    await adds.check(1, "s1", card.token, false)
    // Tried with what the project runs it with.
    expect(fake.trials[0]?.origins).toEqual(["https://a.example"])
    expect(await adds.add(1, "s1", card.token, opened, "folder-a", approvals)).toBe("desk")
    expect(Object.keys(openProject(opened.dir).project.apps)).toEqual(["app", "desk"])
    expect(approvals.get("com.example.Notes")?.scopes["folder-a"]?.opens).toBe(
      opensOf(entry({ origins: ["https://a.example"] })),
    )
  })

  it("refuses a token of another window or project, and a build changed since its trial", async () => {
    const opened = project()
    const apps = { ...at }
    const adds = new DesktopAdds(looks(apps).looks, () => "s1")
    const card = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    await expect(adds.check(2, "s1", card.token, false)).rejects.toThrow(
      /isn't being added any more/,
    )
    await expect(adds.check(1, "s2", card.token, false)).rejects.toThrow(
      /isn't being added any more/,
    )
    await adds.check(1, "s1", card.token, false)
    apps["/Applications/Notes.app"] = notes({
      signer: { kind: "team", team: "OTHER00000", identifier: "x" },
    })
    await expect(
      adds.add(1, "s1", card.token, opened, "folder-a", new DesktopApprovals(dir())),
    ).rejects.toThrow(/changed since it was checked/)
  })

  it("ends a trial when its add is dropped (another pick, the project closed, a quit)", async () => {
    const opened = project()
    let signal: AbortSignal | undefined
    const adds = new DesktopAdds(
      {
        inspect: () => Promise.resolve(notes()),
        trial: (_app, o) => {
          signal = o.signal
          return new Promise<TrialOutcome>((_, reject) =>
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason as Error)),
          )
        },
      },
      () => "s1",
    )
    const card = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    const checking = adds.check(1, "s1", card.token, false)
    adds.dropAll()
    await expect(checking).rejects.toMatchObject({ name: "AbortError" })
    expect(signal?.aborted).toBe(true)
    await expect(adds.check(1, "s1", card.token, false)).rejects.toThrow(
      /isn't being added any more/,
    )
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
  const at = { "/Applications/Notes.app": notes() }
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

  it("shows what it opens, and never approves a project changed since the pick", async () => {
    const opened = named()
    const adds = new DesktopAdds(looks(at).looks, () => "s1")
    const card = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    expect(card.opens).toEqual({ args: ["files/vault"], origins: ["https://a.example"] })
    await adds.check(1, "s1", card.token, false)
    // A pull meanwhile adds a site: what the user saw isn't what would be approved.
    const desk = opened.project.apps["desk"] as ElectronApp
    saveProject(opened, {
      ...opened.project,
      apps: {
        ...opened.project.apps,
        desk: { ...desk, origins: ["https://a.example", "https://evil.example"] },
      },
    })
    await expect(
      adds.add(1, "s1", card.token, opened, "folder-a", new DesktopApprovals(dir())),
    ).rejects.toThrow(/the project changed meanwhile/)
  })

  it("writes a site allowed in its check to the project, and approves that", async () => {
    const opened = project()
    saveProject(opened, { ...opened.project, apps: { ...opened.project.apps, desk: entry() } })
    const fake = looks(at, (o) =>
      (o.origins ?? []).length > 0 ? { ok: true } : { site: "https://app.slack.com" },
    )
    const adds = new DesktopAdds(fake.looks, () => "s1")
    const approvals = new DesktopApprovals(dir())
    const card = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    await adds.check(1, "s1", card.token, false)
    await adds.check(1, "s1", card.token, true)
    expect(await adds.add(1, "s1", card.token, opened, "folder-a", approvals)).toBe("desk")
    const desk = openProject(opened.dir).project.apps["desk"] as ElectronApp
    expect(desk.origins).toEqual(["https://app.slack.com"])
    expect(await desktopStatus(desk, "folder-a", approvals, fake.looks)).toEqual({
      status: "ready",
    })
  })

  it("refuses a second pick while one is looked at, and a second add while one runs", async () => {
    let release: () => void = () => undefined
    const slow = new Promise<void>((resolve) => (release = resolve))
    const adds = new DesktopAdds(
      {
        inspect: async () => {
          await slow
          return notes()
        },
        trial: () => Promise.resolve({ ok: true }),
      },
      () => "s1",
    )
    const opened = project()
    const first = adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    await expect(adds.pick(1, "s1", "/Applications/Notes.app", opened.project)).rejects.toThrow(
      /being looked at/,
    )
    release()
    const card = await first
    await adds.check(1, "s1", card.token, false)
    const approvals = new DesktopApprovals(dir())
    const one = adds.add(1, "s1", card.token, opened, "folder-a", approvals)
    await expect(adds.add(1, "s1", card.token, opened, "folder-a", approvals)).rejects.toThrow(
      /being added already/,
    )
    expect(await one).toBe("notes")
  })
})

describe("an add's lifetime: its project's, whatever changes it", () => {
  const at = { "/Applications/Notes.app": notes() }

  it("never writes an add given up while the app was looked at (cancelled, project changed)", async () => {
    const opened = project()
    let session = "s1"
    let looking = false
    let release: () => void = () => undefined
    const adds = new DesktopAdds(
      {
        inspect: async () => {
          if (looking) await new Promise<void>((resolve) => (release = resolve))
          return notes()
        },
        trial: () => Promise.resolve({ ok: true }),
      },
      () => session,
    )
    const card = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    await adds.check(1, "s1", card.token, false)
    looking = true
    const approvals = new DesktopApprovals(dir())
    const adding = adds.add(1, "s1", card.token, opened, "folder-a", approvals)
    // Another project opened while the app was looked at.
    session = "s2"
    release()
    await expect(adding).rejects.toThrow(/isn't being added any more/)
    expect(openProject(opened.dir).project.apps["notes"]).toBeUndefined()
    expect(approvals.get("com.example.Notes")).toBeUndefined()
    // And cancelled (the window's add dropped) the same way.
    session = "s1"
    looking = false
    const again = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    await adds.check(1, "s1", again.token, false)
    looking = true
    const cancelled = adds.add(1, "s1", again.token, opened, "folder-a", approvals)
    adds.dropFor(1)
    release()
    await expect(cancelled).rejects.toThrow(/isn't being added any more/)
    expect(openProject(opened.dir).project.apps["notes"]).toBeUndefined()
  })

  it("ends a check whose project closed, and refuses a pick for a project no longer open", async () => {
    const opened = project()
    let session: string | undefined = "s1"
    const adds = new DesktopAdds(looks(at).looks, () => session)
    const card = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    session = undefined
    await expect(adds.check(1, "s1", card.token, false)).rejects.toThrow(
      /isn't being added any more/,
    )
    await expect(adds.pick(1, "s1", "/Applications/Notes.app", opened.project)).rejects.toThrow(
      /project changed/,
    )
  })

  it("says a site the project can't take in words, after a check that worked", async () => {
    const opened = project()
    // The site is a web app's of the project already (one app per site).
    saveProject(opened, { ...opened.project, apps: { ...opened.project.apps, desk: entry() } })
    const fake = looks(at, (o) =>
      (o.origins ?? []).length > 0 ? { ok: true } : { site: "https://app.test" },
    )
    const adds = new DesktopAdds(fake.looks, () => "s1")
    const card = await adds.pick(1, "s1", "/Applications/Notes.app", opened.project)
    await adds.check(1, "s1", card.token, false)
    await adds.check(1, "s1", card.token, true)
    const error = await adds
      .add(1, "s1", card.token, opened, "folder-a", new DesktopApprovals(dir()))
      .then(
        () => "",
        (e: unknown) => (e as Error).message,
      )
    expect(error).toMatch(/^the project can't take it so/)
    expect(error).not.toMatch(/"code"|\[\{/)
  })
})
