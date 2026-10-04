import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TakeStore } from "@kiframe/project"
import { memoryBackend } from "@kiframe/vault"
import { describe, expect, it } from "vitest"
import { ProjectIndex, REMOVED_AFTER_MS } from "../src/main/project-index.ts"
import { takeStoreKey } from "../src/main/settings.ts"

const DAY = 24 * 60 * 60 * 1000

/** A project folder with a project.json, and a take of it in the store held by that folder. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "kiframe-index-"))
  const dir = join(root, "demo.kiframe")
  mkdirSync(dir)
  writeFileSync(join(dir, "project.json"), "{}")
  const data = join(root, "data")
  const takes = new TakeStore(data)
  const takeDir = join(data, "takes", "p1", "intro", "take-1790000000000-0123456789ab")
  mkdirSync(takeDir, { recursive: true })
  return { root, dir, data, takes, takeDir, index: new ProjectIndex(data) }
}

/** The index file, with each folder's device set (a drive that isn't the one it was on). */
function onAnotherDevice(data: string) {
  const file = join(data, "projects.json")
  const all = JSON.parse(readFileSync(file, "utf8")) as Record<string, { dev?: number }[]>
  for (const folders of Object.values(all)) for (const f of folders) f.dev = -1
  writeFileSync(file, JSON.stringify(all))
}

describe("removed projects' takes", () => {
  it("go once every folder of the project has been gone for 7 days, pinned ones too", () => {
    const { dir, takes, data, index } = setup()
    index.seen("p1", dir)
    const t0 = Date.now()
    expect(index.sweepRemoved(takes, t0)).toEqual([])
    renameSync(dir, `${dir}-deleted`)
    expect(index.sweepRemoved(takes, t0)).toEqual([])
    expect(index.sweepRemoved(takes, t0 + REMOVED_AFTER_MS - DAY)).toEqual([])
    expect(index.sweepRemoved(takes, t0 + REMOVED_AFTER_MS)).toEqual(["p1"])
    expect(takes.takes("p1", "intro")).toEqual([])
    expect(new ProjectIndex(data).sweepRemoved(takes, t0 + 2 * REMOVED_AFTER_MS)).toEqual([])
  })

  it("stay while the project is back (reopened from where it moved); the old folder's pins go", () => {
    const { root, dir, takes, takeDir, index } = setup()
    index.seen("p1", dir)
    writeFileSync(
      join(takeDir, "pin.json"),
      // As syncProject writes it: the folder resolved (macOS's /var is a link).
      JSON.stringify({
        holders: [{ project: "p1", dir: realpathSync(dir), scene: "intro", by: "composition" }],
      }),
    )
    const t0 = Date.now()
    const moved = join(root, "moved.kiframe")
    renameSync(dir, moved)
    index.sweepRemoved(takes, t0)
    // Reopened from its new place: known there; the old folder, gone 7 days, lets go of its pins.
    index.seen("p1", moved)
    expect(index.sweepRemoved(takes, t0 + REMOVED_AFTER_MS)).toEqual([])
    expect(takes.takes("p1", "intro")).toHaveLength(0) // (no meta: not a take, kept as a folder)
    expect(() => readFileSync(join(takeDir, "pin.json"))).toThrow()
    expect(index.known()).toEqual([{ id: "p1", dirs: [realpathSync(moved)] }])
  })

  it("never go for a drive or share that isn't mounted (a folder on another device), its root included", () => {
    const { dir, takes, data, index } = setup()
    index.seen("p1", dir)
    onAnotherDevice(data)
    renameSync(dir, `${dir}-unplugged`)
    const t0 = Date.now()
    index.sweepRemoved(takes, t0)
    expect(index.sweepRemoved(takes, t0 + 3 * REMOVED_AFTER_MS)).toEqual([])
  })

  it("acts on nothing that doesn't read (a hand edit, a future format)", () => {
    const { takes, data, index } = setup()
    writeFileSync(
      join(data, "projects.json"),
      JSON.stringify({ p1: {}, p2: [], p3: 7, p4: [null, { dirs: [] }] }),
    )
    const t0 = Date.now()
    expect(() => index.sweepRemoved(takes, t0)).not.toThrow()
    expect(index.sweepRemoved(takes, t0 + 2 * REMOVED_AFTER_MS)).toEqual([])
  })
})

describe("the take store's key", () => {
  it("is made once and kept in the keychain; one that doesn't read is never replaced", async () => {
    const backend = memoryBackend()
    const first = await takeStoreKey(backend)
    expect(first.length).toBe(32)
    expect(Buffer.from(await takeStoreKey(backend)).equals(Buffer.from(first))).toBe(true)
    backend.values.set("take-store-key", "not a key")
    await expect(takeStoreKey(backend)).rejects.toThrow(/isn't one/)
    expect(backend.values.get("take-store-key")).toBe("not a key")
  })
})
