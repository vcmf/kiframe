import { EventEmitter } from "node:events"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Worker } from "node:worker_threads"
import { createProject, saveScene, TakeStore } from "@kiframe/project"
import { describe, expect, it } from "vitest"
import { inspectFolder } from "../src/main/folder-inspect.ts"
import { type Inspect, STUCK_FOR_MS, workerInspector } from "../src/main/folder-reader.ts"
import { ProjectIndex } from "../src/main/project-index.ts"
import { TakeKeeper } from "../src/main/take-keeper.ts"

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
    // Another project in its place (a new one, a branch): unknown, never gone.
    expect(inspectFolder({ path: dir, dev }, "p2").state).toBe("unknown")
    renameSync(dir, join(root, "elsewhere"))
    expect(inspectFolder({ path: dir, dev }, "p1")).toEqual({ state: "gone" })
    // Its parent missing too (a sync root signed out, a renamed parent): unknown, never walked up.
    const sync = join(root, "sync")
    mkdirSync(sync)
    const synced = join(sync, "demo.kiframe")
    renameSync(join(root, "elsewhere"), synced)
    rmSync(sync, { recursive: true })
    expect(inspectFolder({ path: synced, dev }, "p1").state).toBe("unknown")
    // On a device that isn't the one around it now (unplugged): unknown, never gone.
    expect(inspectFolder({ path: dir, dev: -1 }, "p1").state).toBe("unknown")
    expect(inspectFolder({ path: dir }, "p1").state).toBe("unknown")
  })

  it("is unknown when it can't be read (a permission): never gone", () => {
    const { root, dir } = setup()
    const dev = statSync(dir).dev
    chmodSync(dir, 0o000)
    try {
      expect(inspectFolder({ path: dir, dev }, "p1").state).toBe("unknown")
    } finally {
      chmodSync(dir, 0o755)
    }
    // Moved out of a folder that can't be read: unknown too (its surroundings can't tell).
    const shut = join(root, "shut")
    mkdirSync(shut)
    const inside = join(shut, "demo.kiframe")
    renameSync(dir, inside)
    rmSync(join(inside, "project.json"))
    chmodSync(shut, 0o000)
    try {
      expect(inspectFolder({ path: inside, dev }, "p1").state).toBe("unknown")
    } finally {
      chmodSync(shut, 0o755)
    }
  })

  it("is never gone in a git working tree (a branch without the project brings it back)", () => {
    const { root, dir } = setup()
    const dev = statSync(dir).dev
    // The project folder its own repo, on a branch without the project: still there, unknown.
    mkdirSync(join(dir, ".git"))
    rmSync(join(dir, "project.json"))
    expect(inspectFolder({ path: dir, dev }, "p1").state).toBe("unknown")
    // Deleted outside any repo: gone. Inside one (a branch without it): unknown.
    rmSync(dir, { recursive: true })
    expect(inspectFolder({ path: dir, dev }, "p1")).toEqual({ state: "gone" })
    mkdirSync(join(root, ".git"))
    expect(inspectFolder({ path: dir, dev }, "p1").state).toBe("unknown")
  })

  it("says which scenes didn't read: a broken part or a missing folder, never one outside the sequence", () => {
    const { dir, opened } = setup()
    for (const id of ["draft", "intro"]) {
      saveScene(
        opened,
        { version: 1, id, title: id, source: { kind: "recording" }, duration: { mode: "auto" } },
        {},
      )
    }
    // draft out of the sequence (it reads); outro in it with no folder (mid-sync).
    const file = join(dir, "project.json")
    const project = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...project, sequence: ["intro", "outro"] }))
    const state = inspectFolder({ path: dir, dev: statSync(dir).dev }, "p1")
    expect(state.state === "here" && state.unread).toEqual(["outro"])
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
    let made = 0
    let now = 0
    const reader = workerInspector(
      () => (made++, hung()),
      50,
      () => now,
    )
    expect(await reader.inspect({ path: "/x", dev: 1 }, "p1")).toEqual({
      state: "unknown",
      why: "it didn't answer in time",
    })
    expect(ended).toBe(1)
    // A while after, every folder unknown with no new worker (never one stuck thread a folder).
    expect((await reader.inspect({ path: "/y", dev: 1 }, "p1")).state).toBe("unknown")
    expect(made).toBe(1)
    now += STUCK_FOR_MS
    await reader.inspect({ path: "/y", dev: 1 }, "p1")
    expect(made).toBe(2)
    // Closed (the app quitting), past the stuck while: answered unknown, no worker made.
    now += STUCK_FOR_MS
    reader.close()
    expect((await reader.inspect({ path: "/z", dev: 1 }, "p1")).state).toBe("unknown")
    expect(made).toBe(2)
  })

  it("answers at once when its worker ends without an error, and isn't stuck after", async () => {
    let made = 0
    const exiting = () => {
      made += 1
      const w = new EventEmitter() as unknown as Worker
      Object.assign(w, {
        postMessage: () => setImmediate(() => w.emit("exit", 1)),
        terminate: () => Promise.resolve(0),
      })
      return w
    }
    const reader = workerInspector(exiting, 60_000)
    expect(await reader.inspect({ path: "/x", dev: 1 }, "p1")).toEqual({
      state: "unknown",
      why: "its reader ended",
    })
    await reader.inspect({ path: "/y", dev: 1 }, "p1")
    expect(made).toBe(2)
  })
})

describe("the project index", () => {
  it("keeps a backup never a change behind, and never writes over a file that doesn't read", () => {
    const { root, dir, data, index } = setup()
    index.seen("p1", dir)
    const moved = join(root, "moved.kiframe")
    mkdirSync(moved)
    index.seen("p1", moved)
    // Broken or lost: its backup holds the latest folder too.
    writeFileSync(join(data, "projects.json"), "{ half")
    expect(index.folders("p1")).toHaveLength(2)
    rmSync(join(data, "projects.json"))
    expect(index.folders("p1")).toHaveLength(2)
    // Neither reads: both kept aside, the index started again (never stuck unwritten for good).
    writeFileSync(join(data, "projects.json"), "{ half")
    writeFileSync(join(data, "projects.json.bak"), "{ half")
    index.seen("p2", dir)
    expect(Object.keys(index.all())).toEqual(["p2"])
    expect(readdirSync(data).filter((n) => n.includes(".broken-"))).toHaveLength(2)
  })
})

describe("the take keeper", () => {
  /** A store whose eviction asks p1 and keeps what it was told (and the lock's answer). */
  const asking = (during?: () => void) => {
    const seen: { named: unknown; unchanged?: boolean } = { named: undefined }
    const store = {
      evict: async (
        namedBy: (id: string) => Promise<unknown>,
        _now: number,
        unchanged: (id: string) => boolean,
      ) => {
        seen.named = await namedBy("p1")
        during?.()
        seen.unchanged = unchanged("p1")
        return []
      },
    } as unknown as TakeStore
    return { store, seen }
  }
  const here = (scenes: Record<string, string>) =>
    Promise.resolve({ state: "here" as const, scenes, unread: ["broken"] })
  const gone = () => Promise.resolve({ state: "gone" as const })
  const unknown = () => Promise.resolve({ state: "unknown" as const, why: "unplugged" })

  it("tells eviction what a project's folders name: merged, vanished, or keep", async () => {
    const { dir, index } = setup()
    const answer = async (inspect: Inspect, open?: string) => {
      const { store, seen } = asking()
      await new TakeKeeper(store, index, inspect, () => open).evict()
      return seen.named
    }
    // Not known: keep.
    expect(await answer(() => here({}))).toBe("keep")
    index.seen("p1", dir)
    expect(await answer(() => here({ intro: "k1" }))).toEqual({
      scenes: new Map([["intro", new Set(["k1"])]]),
      unread: new Set(["broken"]),
    })
    // Every folder gone (deleted, or moved and not opened since): vanished.
    expect(await answer(gone)).toBe("vanished")
    // ...unless it's open now (its index write failed): keep.
    expect(await answer(gone, "p1")).toBe("keep")
    index.seen("p1", `${dir}-copy`)
    let n = 0
    // One copy there, one gone: the one there names (a gone copy names nothing).
    expect(await answer(() => (++n % 2 === 1 ? here({ intro: "k1" }) : gone()))).toEqual({
      scenes: new Map([["intro", new Set(["k1"])]]),
      unread: new Set(["broken"]),
    })
    // One that can't be read now: keep.
    expect(await answer(() => (++n % 2 === 1 ? here({}) : unknown()))).toBe("keep")
  })

  it("lets nothing of a project go when it's opened from a new place during the pass, or opened with a folder gone", async () => {
    const { root, dir, index } = setup()
    index.seen("p1", dir)
    const steady = asking()
    await new TakeKeeper(steady.store, index, gone).evict()
    expect(steady.seen.unchanged).toBe(true)
    const reopened = asking(() => index.seen("p1", join(root, "moved.kiframe")))
    await new TakeKeeper(reopened.store, index, gone).evict()
    expect(reopened.seen.unchanged).toBe(false)
    // Opened during the pass with its index write failed (decided vanished): nothing goes.
    let open: string | undefined
    const opening = asking(() => (open = "p1"))
    await new TakeKeeper(opening.store, index, gone, () => open).evict()
    expect(opening.seen.named).toBe("vanished")
    expect(opening.seen.unchanged).toBe(false)
    // Open with every folder there: its scratch may go (never paid for by other projects).
    const working = asking()
    await new TakeKeeper(
      working.store,
      index,
      () => here({}),
      () => "p1",
    ).evict()
    expect(working.seen.unchanged).toBe(true)
  })

  it("never deletes a vanished project's takes while the store is under the budget", async () => {
    const { root, dir, takes, index, data } = setup()
    mkdirSync(join(data, "takes", "p1", "intro"), { recursive: true })
    index.seen("p1", dir)
    renameSync(dir, join(root, "deleted"))
    const keeper = new TakeKeeper(takes, index, inProcess, undefined, () => Date.now() + 30 * DAY)
    await keeper.evict()
    expect(statSync(join(data, "takes", "p1")).isDirectory()).toBe(true)
  })

  it("runs a pass asked for meanwhile even when the one before failed", async () => {
    let passes = 0
    const store = {
      evict: () => {
        passes += 1
        // A recording finishes during the first pass, which then fails.
        if (passes === 1) {
          return Promise.resolve().then(() => {
            void keeper.evict()
            throw new Error("disk")
          })
        }
        return Promise.resolve([])
      },
    } as unknown as TakeStore
    const keeper = new TakeKeeper(store, setup().index, unknown)
    await keeper.evict()
    expect(passes).toBe(2)
  })
})
