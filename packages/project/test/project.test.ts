import { randomBytes } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { recordScenario } from "@kiframe/runtime"
import { parseProjectYaml, parseScenarioYaml, type Scenario, type Scene } from "@kiframe/schema"
import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { startFixtureServer } from "../../runtime/test/fixture-server.ts"
import {
  createProject,
  openProject,
  ProjectChangedError,
  removeScene,
  reorderScenes,
  isEncrypted,
  readTakeRecords,
  saveScene,
  TakeStore,
} from "../src/index.ts"

const folder = () => join(mkdtempSync(join(tmpdir(), "kiframe-project-")), "demo.kiframe")
const scene = (id: string, title = id): Scene => ({
  version: 1,
  id,
  title,
  source: { kind: "recording" },
  duration: { mode: "auto" },
})
const scenario = parseScenarioYaml(
  "version: 1\nsteps:\n  - { id: open, action: goto, url: /projects }\n",
)

describe("project store", () => {
  it("creates a project, saves scenes with their scenario, and opens them back", () => {
    const dir = folder()
    const made = createProject(dir, { id: "p1", name: "Q4 release", url: "https://app.test" })
    saveScene(made, scene("login", "Log in"), { scenario })
    saveScene(made, scene("create"))
    const opened = openProject(dir)
    expect(opened.problems).toEqual([])
    expect(opened.project.sequence).toEqual(["login", "create"])
    expect(opened.scenes.get("login")?.scene.title).toBe("Log in")
    expect(opened.scenes.get("login")?.scenario).toEqual(scenario)
    expect(opened.scenes.get("create")?.scenario).toBeUndefined()
    // Stable, readable JSON on disk.
    expect(readFileSync(join(dir, "project.json"), "utf8")).toMatch(/^\{\n {2}"version": 1,/)
  })

  it("refuses to create over an existing project, or to write an invalid scene", () => {
    const dir = folder()
    const made = createProject(dir, { id: "p1", name: "Q4", url: "https://app.test" })
    expect(() => createProject(dir, { id: "p2", name: "X", url: "https://app.test" })).toThrow(
      /already holds a project/,
    )
    expect(() => saveScene(made, { ...scene("bad"), title: "" })).toThrow()
    expect(openProject(dir).scenes.size).toBe(0)
  })

  it("keeps a scene's scenario when only its object changes, and removes it on null", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    saveScene(made, scene("login"), { scenario })
    saveScene(made, scene("login", "Sign in"))
    expect(openProject(made.dir).scenes.get("login")?.scenario).toEqual(scenario)
    saveScene(made, scene("login"), { scenario: null })
    expect(openProject(made.dir).scenes.get("login")?.scenario).toBeUndefined()
  })

  it("reorders and removes scenes (outputs follow)", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    for (const id of ["a", "b", "c"]) saveScene(made, scene(id))
    reorderScenes(made, ["c", "a", "b"])
    expect(() => reorderScenes(made, ["a", "b"])).toThrow(/exactly the scenes/)
    removeScene(made, "a")
    const opened = openProject(made.dir)
    expect(opened.project.sequence).toEqual(["c", "b"])
    expect([...opened.scenes.keys()].sort()).toEqual(["b", "c"])
  })

  it("reports a broken scene folder and still opens the rest", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    saveScene(made, scene("good"))
    saveScene(made, scene("broken"))
    writeFileSync(join(made.dir, "scenes", "broken", "scene.json"), "{ not json")
    const opened = openProject(made.dir)
    expect([...opened.scenes.keys()]).toEqual(["good"])
    expect(opened.problems.map((p) => p.sceneId)).toEqual(["broken"])
  })
})

describe("project store: failures and conflicts", () => {
  it("writes nothing when any part is invalid (a new scene stays out)", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    const bad = { version: 1, steps: [{ id: "x", action: "nope" }] } as unknown as Scenario
    expect(() => saveScene(made, scene("checkout"), { scenario: bad })).toThrow()
    expect(existsSync(join(made.dir, "scenes", "checkout"))).toBe(false)
    expect(openProject(made.dir).project.sequence).toEqual([])
    // An existing scene: neither its title nor its scenario changes.
    saveScene(made, scene("login", "Log in"), { scenario })
    expect(() => saveScene(made, scene("login", "Sign in"), { scenario: bad })).toThrow()
    const login = openProject(made.dir).scenes.get("login")
    expect(login?.scene.title).toBe("Log in")
    expect(login?.scenario).toEqual(scenario)
  })

  it("never overwrites a change made on disk since the project was read", () => {
    const dir = folder()
    createProject(dir, { id: "p1", name: "Q4", url: "https://app.test" })
    const a = openProject(dir)
    const b = openProject(dir)
    saveScene(b, scene("intro"))
    expect(() => saveScene(a, scene("outro"))).toThrow(ProjectChangedError)
    expect(openProject(dir).project.sequence).toEqual(["intro"])
  })

  it("reports a scene folder outside the sequence", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    saveScene(made, scene("a"))
    mkdirSync(join(made.dir, "scenes", "stray"))
    writeFileSync(join(made.dir, "scenes", "stray", "scene.json"), JSON.stringify(scene("stray")))
    expect(openProject(made.dir).problems).toEqual([
      { sceneId: "stray", message: "a scene folder that isn't in the sequence" },
    ])
  })

  it("reads a scene's parts on their own, and repairs only the broken one", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    saveScene(made, scene("login", "Log in"), { scenario })
    writeFileSync(join(made.dir, "scenes", "login", "composition.json"), "{ bad")
    const opened = openProject(made.dir)
    // The good parts still load; the broken one is named.
    expect(opened.scenes.get("login")?.scenario).toEqual(scenario)
    expect(opened.problems).toEqual([
      expect.objectContaining({ sceneId: "login", part: "composition" }),
    ])
    expect(() => saveScene(opened, scene("login", "Sign in"))).toThrow(
      /composition.json didn't read/,
    )
    saveScene(opened, scene("login", "Sign in"), { composition: null })
    const back = openProject(made.dir)
    expect(back.problems).toEqual([])
    expect(back.scenes.get("login")?.scenario).toEqual(scenario)
  })

  it("never overwrites a scene file changed on disk (a hand edit, a git pull)", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    saveScene(made, scene("login"), { scenario })
    const pulled = "version: 1\nsteps:\n  - { id: other, action: goto, url: /other }\n"
    writeFileSync(join(made.dir, "scenes", "login", "scenario.yaml"), pulled)
    expect(() => saveScene(made, scene("login", "Sign in"), { scenario })).toThrow(
      ProjectChangedError,
    )
    expect(() => removeScene(made, "login")).toThrow(ProjectChangedError)
    expect(readFileSync(join(made.dir, "scenes", "login", "scenario.yaml"), "utf8")).toBe(pulled)
  })

  it("removes stray temporary files on open", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    writeFileSync(join(made.dir, ".0123456789ab.tmp"), "x")
    openProject(made.dir)
    expect(existsSync(join(made.dir, ".0123456789ab.tmp"))).toBe(false)
  })

  it("never touches a folder that isn't a project (picked by mistake)", () => {
    const other = mkdtempSync(join(tmpdir(), "kiframe-not-a-project-"))
    writeFileSync(join(other, ".0123456789ab.tmp"), "someone's file")
    expect(() => openProject(other)).toThrow(/isn't a Kiframe project \(it has no project.json\)/)
    expect(existsSync(join(other, ".0123456789ab.tmp"))).toBe(true)
  })

  it("removes only files that look like its own leftovers, never a folder", () => {
    const made = createProject(folder(), { id: "p1", name: "Q4", url: "https://app.test" })
    mkdirSync(join(made.dir, ".0123456789ab.tmp"))
    expect(() => openProject(made.dir)).not.toThrow()
    expect(existsSync(join(made.dir, ".0123456789ab.tmp"))).toBe(true)
  })
})

describe("take store (with the real recorder)", () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>>
  let browser: Browser
  beforeAll(async () => {
    server = await startFixtureServer()
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
    await server.close()
  })
  const config = () =>
    parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
  const record = async (store: TakeStore, sceneId: string, steps: string) => {
    const dir = store.newTakeDir("p1", sceneId)
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    const s = parseScenarioYaml(`version: 1\nsetup: [{ action: goto, url: / }]\nsteps:\n${steps}`)
    const error = await recordScenario(page, s, config(), { outDir: dir, timeoutMs: 1500 }).then(
      () => undefined,
      (e: unknown) => e,
    )
    await page.close()
    return { dir, error, take: await store.settle(dir) }
  }
  const newStore = () => new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-")))

  it("keeps a complete take privately, and finds it newest first and by key", async () => {
    const store = newStore()
    const first = await record(store, "login", "  - { id: a, action: pause, ms: 50 }\n")
    const second = await record(store, "login", "  - { id: b, action: pause, ms: 50 }\n")
    expect(first.error).toBeUndefined()
    expect(second.take?.dir).toBe(second.dir)
    // Private through its root: nothing inside is reachable by other users.
    expect(statSync(store.root).mode & 0o777).toBe(0o700)
    expect(store.takes("p1", "login").map((t) => t.dir)).toEqual([second.dir, first.dir])
    expect(store.latest("p1", "login")?.dir).toBe(second.dir)
    const key = first.take?.meta.takeKey ?? ""
    expect(store.take("p1", "login", key)?.dir).toBe(first.dir)
    expect(store.latest("p1", "other")).toBeUndefined()
  })

  it("deletes a failed recording's frames, keeps why it failed, and a private store", async () => {
    const store = newStore()
    const failed = await record(
      store,
      "login",
      "  - { id: x, action: click, target: { by: role, role: button, name: Nothing here } }\n",
    )
    expect(failed.error).toBeDefined()
    expect(failed.take).toBeUndefined()
    // Only its meta.json (the reason), warnings and the recorder's marker are left: no frames.
    const left = readdirSync(`${failed.dir}.failed`).sort()
    const kept = ["meta.json", "warnings.json", ".kiframe-take"]
    expect(left.every((n) => kept.includes(n))).toBe(true)
    expect(left).toContain("meta.json")
    expect(statSync(store.root).mode & 0o777).toBe(0o700)
    // Only a folder the store named is settled.
    await expect(store.settle(join(store.root, "..", "elsewhere"))).rejects.toThrow(
      /not a take folder/,
    )
  })

  it("keeps a set-aside take while it's the only copy, and refuses a newer Kiframe's take", async () => {
    const store = newStore()
    await record(store, "login", "  - { id: a, action: pause, ms: 50 }\n")
    const scene = join(store.root, "takes", "p1", "login")
    // A crash mid-swap: the previous take set aside, its replacement never renamed in.
    const lost = "take-1790000000000-0123456789ab"
    mkdirSync(join(scene, `${lost}.old-1-2`))
    store.sweep()
    expect(existsSync(join(scene, `${lost}.old-1-2`))).toBe(true)
    // A take a newer Kiframe wrote: an error, never skipped for an older take.
    const newer = "take-9999999999999-0123456789ab"
    mkdirSync(join(scene, newer))
    writeFileSync(join(scene, newer, "meta.json"), JSON.stringify({ version: 99 }))
    expect(() => store.latest("p1", "login")).toThrow(/newer Kiframe/)
    expect(store.takes("p1", "login")).toHaveLength(1)
  })

  it("sweeps a crash's leftovers at start, and nothing else", async () => {
    const store = newStore()
    const kept = await record(store, "login", "  - { id: a, action: pause, ms: 50 }\n")
    const scene = join(store.root, "takes", "p1", "login")
    const name = "take-1790000000000-deadbeef0000"
    mkdirSync(join(scene, `${name}.failed`))
    writeFileSync(join(scene, `${name}.failed`, "frames.webm"), "raw")
    writeFileSync(join(scene, `${name}.failed`, "meta.json"), "{}")
    mkdirSync(join(scene, `.${name}.recording-1-2`))
    mkdirSync(join(scene, `${basename(kept.dir)}.old-1-2`))
    writeFileSync(join(scene, "notes.txt"), "not ours")
    store.sweep()
    expect(readdirSync(scene).sort()).toEqual(
      [basename(kept.dir), `${name}.failed`, "notes.txt"].sort(),
    )
    expect(readdirSync(join(scene, `${name}.failed`))).toEqual(["meta.json"])
  })

  it("encrypts a take as it settles: opened with the store's key, never readable without", async () => {
    const key = randomBytes(32)
    const store = new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-")), {
      key: () => Promise.resolve(key),
    })
    const { take } = await record(store, "login", "  - { id: a, action: pause, ms: 50 }\n")
    if (take === undefined) throw new Error("no take")
    for (const file of ["frames.webm", "events.jsonl", "cursor.jsonl"]) {
      expect(isEncrypted(readFileSync(join(take.dir, file))), file).toBe(true)
    }
    // Listing needs no key (meta.json stays plain).
    expect(store.latest("p1", "login")?.meta.takeKey).toBe(take.meta.takeKey)
    const opened = await store.open(take)
    expect(opened.records.events.length).toBeGreaterThan(0)
    expect(opened.video.subarray(0, 4).toString("hex")).toBe("1a45dfa3") // a WebM (EBML) header
    // Without the key, or with another one: said, never wrong bytes.
    expect(() => readTakeRecords(take.dir)).toThrow(/encrypted: no take key/)
    const other = new TakeStore(store.root, { key: () => Promise.resolve(randomBytes(32)) })
    await expect(other.open(take)).rejects.toThrow(/don't open with this computer's take key/)
    // A take from before (plain) opens with a store that has a key.
    const plainStore = newStore()
    const old = await record(plainStore, "login", "  - { id: a, action: pause, ms: 50 }\n")
    if (old.take === undefined) throw new Error("no take")
    const keyed = new TakeStore(plainStore.root, { key: () => Promise.resolve(key) })
    expect((await keyed.open(old.take)).video.length).toBeGreaterThan(0)
  })

  it("seals at start what a crash left plain, and never keeps a take it can't encrypt", async () => {
    const key = randomBytes(32)
    const plainStore = newStore()
    const { take } = await record(plainStore, "login", "  - { id: a, action: pause, ms: 50 }\n")
    if (take === undefined) throw new Error("no take")
    writeFileSync(join(take.dir, ".0123456789ab.tmp"), "half written")
    const keyed = new TakeStore(plainStore.root, { key: () => Promise.resolve(key) })
    expect(await keyed.seal()).toEqual({ sealed: 1, failed: [] })
    expect(isEncrypted(readFileSync(join(take.dir, "frames.webm")))).toBe(true)
    expect(existsSync(join(take.dir, ".0123456789ab.tmp"))).toBe(false)
    expect((await keyed.open(take)).records.events.length).toBeGreaterThan(0)
    // The keychain refusing: the take is deleted, never kept plain.
    const refused = new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-")), {
      key: () => Promise.reject(new Error("the keychain said no")),
    })
    const dir = refused.newTakeDir("p1", "login")
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    const s = parseScenarioYaml(
      `version: 1\nsetup: [{ action: goto, url: / }]\nsteps:\n  - { id: a, action: pause, ms: 50 }\n`,
    )
    await recordScenario(page, s, config(), { outDir: dir, timeoutMs: 1500 })
    await page.close()
    await expect(refused.settle(dir)).rejects.toThrow(
      /couldn't be encrypted \(the take key: the keychain said no\): deleted/,
    )
    expect(existsSync(dir)).toBe(false)
  })

  it("seals every take it can at start: one that fails is said, the others sealed, leftovers gone", async () => {
    const plainStore = newStore()
    const a = await record(plainStore, "login", "  - { id: a, action: pause, ms: 50 }\n")
    const b = await record(plainStore, "other", "  - { id: b, action: pause, ms: 50 }\n")
    if (a.take === undefined || b.take === undefined) throw new Error("no take")
    mkdirSync(join(a.take.dir, "shots"), { recursive: true })
    writeFileSync(join(a.take.dir, "shots", ".0123456789ab.tmp"), "half a shot")
    // b's frames can't be read: b fails, a is sealed all the same.
    rmSync(join(b.take.dir, "frames.webm"))
    mkdirSync(join(b.take.dir, "frames.webm"))
    const keyed = new TakeStore(plainStore.root, { key: () => Promise.resolve(randomBytes(32)) })
    const result = await keyed.seal()
    expect(result.sealed).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toContain(b.take.dir)
    expect(isEncrypted(readFileSync(join(a.take.dir, "frames.webm")))).toBe(true)
    expect(existsSync(join(a.take.dir, "shots", ".0123456789ab.tmp"))).toBe(false)
    // Nothing left to seal: the key is never asked (an empty or sealed store never prompts).
    const refusing = new TakeStore(plainStore.root, {
      key: () => Promise.reject(new Error("locked")),
    })
    rmSync(b.take.dir, { recursive: true })
    expect(await refusing.seal()).toEqual({ sealed: 0, failed: [] })
  })

  it("refuses a sealed take's file without the magic (changed), and opens a plain take without the key", async () => {
    const key = randomBytes(32)
    const store = new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-")), {
      key: () => Promise.resolve(key),
    })
    const { take } = await record(store, "login", "  - { id: a, action: pause, ms: 50 }\n")
    if (take === undefined) throw new Error("no take")
    expect(existsSync(join(take.dir, ".sealed"))).toBe(true)
    // Its frames' header damaged: refused as changed, never handed on as plain bytes.
    const frames = readFileSync(join(take.dir, "frames.webm"))
    writeFileSync(
      join(take.dir, "frames.webm"),
      Buffer.concat([Buffer.from("XXXX"), frames.subarray(4)]),
    )
    await expect(store.open(take)).rejects.toThrow(/another key, or changed/)
    // A plain take from before: opened with the keychain locked (no key needed).
    const plainStore = newStore()
    const old = await record(plainStore, "login", "  - { id: a, action: pause, ms: 50 }\n")
    if (old.take === undefined) throw new Error("no take")
    const locked = new TakeStore(plainStore.root, {
      key: () => Promise.reject(new Error("locked")),
    })
    expect((await locked.open(old.take)).video.length).toBeGreaterThan(0)
  })

  it("asks a refusing keychain once at start, however many takes wait to be sealed", async () => {
    const plainStore = newStore()
    await record(plainStore, "login", "  - { id: a, action: pause, ms: 50 }\n")
    await record(plainStore, "other", "  - { id: b, action: pause, ms: 50 }\n")
    let asked = 0
    const refusing = new TakeStore(plainStore.root, {
      key: () => {
        asked += 1
        return Promise.reject(new Error("locked"))
      },
    })
    expect(await refusing.seal()).toEqual({ sealed: 0, failed: ["the take key: locked"] })
    expect(asked).toBe(1)
  })

  it("keeps a take a disk error stopped from being encrypted, says so, and seals it next start", async () => {
    const key = randomBytes(32)
    const store = new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-data-")), {
      key: () => Promise.resolve(key),
    })
    const dir = store.newTakeDir("p1", "login")
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    const s = parseScenarioYaml(
      `version: 1\nsetup: [{ action: goto, url: / }]\nsteps:\n  - { id: a, action: pause, ms: 50 }\n`,
    )
    await recordScenario(page, s, config(), { outDir: dir, timeoutMs: 1500 })
    await page.close()
    // Nothing can be written in the take's folder (as on a full disk).
    chmodSync(dir, 0o500)
    let settled
    try {
      settled = await store.settle(dir)
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(settled?.warning).toMatch(/stays unencrypted until Kiframe starts again/)
    expect(existsSync(join(dir, ".sealed"))).toBe(false)
    expect(isEncrypted(readFileSync(join(dir, "frames.webm")))).toBe(false)
    expect(await store.seal()).toEqual({ sealed: 1, failed: [] })
    expect(isEncrypted(readFileSync(join(dir, "frames.webm")))).toBe(true)
  })
})
