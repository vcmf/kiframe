import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import { createProject, saveScene, TakeStore } from "@kiframe/project"
import { describe, expect, it } from "vitest"
import { inspectFolder } from "../src/main/folder-inspect.ts"
import { workerInspector } from "../src/main/folder-reader.ts"
import { ProjectIndex } from "../src/main/project-index.ts"
import { REMOVED_AFTER_MS, TakeKeeper } from "../src/main/take-keeper.ts"

const DAY = 24 * 60 * 60 * 1000
const inProcess = (folder: Parameters<typeof inspectFolder>[0], id: string) =>
  Promise.resolve(inspectFolder(folder, id))

/** A project folder (a scene whose composition names a take), a store, an index. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "kiframe-keeper-"))
  const dir = join(root, "demo.kiframe")
  const opened = createProject(dir, { id: "p1", name: "Demo", url: "https://app.test" })
  const data = join(root, "data")
  return { root, dir, opened, data, takes: new TakeStore(data), index: new ProjectIndex(data) }
}

describe("a project folder, read for the take store", () => {
  it("is here (what it names), gone (on its device), or unknown (another device)", () => {
    const { root, dir, opened } = setup()
    saveScene(
      opened,
      {
        version: 1,
        id: "intro",
        title: "Intro",
        source: { kind: "recording" },
        duration: { mode: "auto" },
      },
      {},
    )
    const dev = statSync(dir).dev
    expect(inspectFolder({ path: dir, dev }, "p1")).toEqual({
      state: "here",
      scenes: {},
      unread: [],
    })
    // Another project in its place: gone for this one.
    expect(inspectFolder({ path: dir, dev }, "p2")).toEqual({ state: "gone" })
    renameSync(dir, join(root, "elsewhere"))
    expect(inspectFolder({ path: dir, dev }, "p1")).toEqual({ state: "gone" })
    // On a device that isn't the one around it now (unplugged): unknown, never gone.
    expect(inspectFolder({ path: dir, dev: -1 }, "p1").state).toBe("unknown")
    expect(inspectFolder({ path: dir }, "p1").state).toBe("unknown")
  })

  it("is unknown when the worker doesn't answer in time (a stuck mount), its worker ended", async () => {
    let ended = 0
    const hung = () => {
      const w = new EventEmitter() as unknown as Worker
      Object.assign(w, {
        postMessage: () => undefined,
        terminate: () => {
          ended += 1
          return Promise.resolve(0)
        },
      })
      return w
    }
    const reader = workerInspector(hung, 50)
    expect(await reader.inspect({ path: "/x", dev: 1 }, "p1")).toEqual({
      state: "unknown",
      why: "it didn't answer in time",
    })
    expect(ended).toBe(1)
  })
})

describe("the project index", () => {
  it("is never written over when it doesn't read (its backup read instead, or nothing written)", () => {
    const { dir, data, index } = setup()
    index.seen("p1", dir)
    index.seen("p1", dir)
    expect(index.folders("p1")).toHaveLength(1)
    writeFileSync(join(data, "projects.json"), "{ half")
    // The backup (the index before the last write) is read.
    expect(index.folders("p1")).toHaveLength(1)
    writeFileSync(join(data, "projects.json.bak"), "{ half")
    index.seen("p2", dir)
    expect(readFileSync(join(data, "projects.json"), "utf8")).toBe("{ half")
  })
})

describe("the take keeper", () => {
  it("removes a project's takes once every folder has been gone 7 days, and forgets a copy gone 7 days", async () => {
    const { root, dir, takes, index, data } = setup()
    mkdirSync(join(data, "takes", "p1", "intro"), { recursive: true })
    index.seen("p1", dir)
    let now = Date.now()
    const keeper = new TakeKeeper(takes, index, inProcess, () => now)
    renameSync(dir, join(root, "deleted"))
    await keeper.tidy()
    expect(index.folders("p1")[0]?.missingSince).toBe(now)
    now += REMOVED_AFTER_MS - DAY
    await keeper.tidy()
    expect(index.folders("p1")).toHaveLength(1)
    now += DAY
    await keeper.tidy()
    expect(index.folders("p1")).toEqual([])
    expect(() => statSync(join(data, "takes", "p1"))).toThrow()
  })

  it("keeps a project's takes when it's opened again before 7 days (moved), and forgets the old folder", async () => {
    const { root, dir, takes, index, data } = setup()
    mkdirSync(join(data, "takes", "p1", "intro"), { recursive: true })
    index.seen("p1", dir)
    let now = Date.now()
    const keeper = new TakeKeeper(takes, index, inProcess, () => now)
    const moved = join(root, "moved.kiframe")
    renameSync(dir, moved)
    await keeper.tidy()
    index.seen("p1", moved)
    now += REMOVED_AFTER_MS
    await keeper.tidy()
    expect(statSync(join(data, "takes", "p1")).isDirectory()).toBe(true)
    expect(index.folders("p1").map((f) => f.path)).toEqual([index.folders("p1")[0]?.path])
    expect(index.folders("p1")[0]?.path).toContain("moved.kiframe")
  })

  it("tells eviction a project's named takes only when every folder is read; else keep", async () => {
    const { dir, index } = setup()
    const answers: unknown[] = []
    const store = {
      evict: async (namedBy: (id: string) => Promise<unknown>) => {
        answers.push(await namedBy("p1"), await namedBy("unknown-project"))
        return []
      },
    } as unknown as TakeStore
    index.seen("p1", dir)
    const here = (scenes: Record<string, string>) =>
      Promise.resolve({ state: "here" as const, scenes, unread: ["broken"] })
    await new TakeKeeper(store, index, () => here({ intro: "k1" })).evict()
    expect(answers).toEqual([
      { scenes: new Map([["intro", new Set(["k1"])]]), unread: new Set(["broken"]) },
      "keep",
    ])
    answers.length = 0
    // A second copy that can't be read now: the project keeps every take.
    index.seen("p1", `${dir}-copy`)
    let n = 0
    await new TakeKeeper(store, index, () =>
      ++n === 1 ? here({}) : Promise.resolve({ state: "unknown" as const, why: "unplugged" }),
    ).evict()
    expect(answers[0]).toBe("keep")
  })
})
