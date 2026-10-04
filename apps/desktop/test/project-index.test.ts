import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TakeStore } from "@kiframe/project"
import { memoryBackend } from "@kiframe/vault"
import { describe, expect, it } from "vitest"
import { ProjectIndex, REMOVED_AFTER_MS } from "../src/main/project-index.ts"
import { takeStoreKey } from "../src/main/settings.ts"

const DAY = 24 * 60 * 60 * 1000

/** A project folder with a project.json, and a take folder of it in the store. */
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

  it("stay while the project is back (reopened from where it moved) or on a drive not there", () => {
    const { root, dir, takes, index } = setup()
    index.seen("p1", dir)
    const t0 = Date.now()
    const moved = join(root, "moved.kiframe")
    renameSync(dir, moved)
    index.sweepRemoved(takes, t0)
    // Reopened from its new place before 7 days: known there, the clock starts over.
    index.seen("p1", moved)
    expect(index.sweepRemoved(takes, t0 + 2 * REMOVED_AFTER_MS)).toEqual([])
    // A folder on a drive that isn't there (its parent missing): never counted as removed.
    index.seen("p2", join(root, "unplugged-drive", "other.kiframe"))
    renameSync(moved, `${moved}-deleted`)
    index.sweepRemoved(takes, t0)
    const removed = index.sweepRemoved(takes, t0 + 3 * REMOVED_AFTER_MS)
    expect(removed).toEqual(["p1"])
    expect(removed).not.toContain("p2")
  })
})

describe("removed projects, read with care", () => {
  it("never counts an unmounted share's empty mount folder, nor an entry that doesn't read", () => {
    const { root, takes, data, index } = setup()
    const mount = join(root, "mnt", "share")
    mkdirSync(mount, { recursive: true })
    index.seen("p1", join(mount, "demo.kiframe"))
    const t0 = Date.now()
    index.sweepRemoved(takes, t0)
    expect(index.sweepRemoved(takes, t0 + 2 * REMOVED_AFTER_MS)).toEqual([])
    // A hand-edited or future index: entries without folders are left alone, never removed.
    writeFileSync(join(data, "projects.json"), JSON.stringify({ p1: {}, p2: { dirs: [] }, p3: 7 }))
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
