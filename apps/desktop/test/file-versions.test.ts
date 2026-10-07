import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FileVersions } from "../src/main/file-versions.ts"

// C2: the files the agent replaced or deleted, kept in the app's data until history.
const folder = () => mkdtempSync(join(tmpdir(), "kiframe-versions-"))
const kept = (root: string) =>
  readdirSync(root).flatMap((d) =>
    readdirSync(join(root, d))
      .filter((n) => n.endsWith(".bin"))
      .map((n) => readFileSync(join(root, d, n), "utf8")),
  )

describe("kept versions", () => {
  it("keeps the last 5 of a file, each named apart (two in one millisecond too)", () => {
    const root = folder()
    const versions = new FileVersions(root)
    for (let i = 1; i <= 7; i++) versions.keep("pages/a.html", Buffer.from(`v${i}`))
    expect(kept(root).sort()).toEqual(["v3", "v4", "v5", "v6", "v7"])
    const [dir] = readdirSync(root)
    expect(readFileSync(join(root, dir ?? "", "path.txt"), "utf8")).toBe("pages/a.html")
  })

  it("drops a version past 30 days", () => {
    const root = folder()
    const versions = new FileVersions(root, { sweepEveryMs: 0 })
    versions.keep("pages/a.html", Buffer.from("fresh"))
    const [dir] = readdirSync(root)
    const name = readdirSync(join(root, dir ?? "")).find((n) => n.endsWith(".bin")) ?? ""
    // A version made 31 days ago (its name says when).
    const stale = `${String(Date.now() - 31 * 24 * 3600 * 1000).padStart(15, "0")}${name.slice(15)}`
    writeFileSync(join(root, dir ?? "", stale), "stale")
    versions.keep("pages/b.html", Buffer.from("b"))
    expect(kept(root).sort()).toEqual(["b", "fresh"])
  })

  it("keeps a project's versions under its bound, the oldest going first", () => {
    const root = folder()
    const versions = new FileVersions(root, { maxBytes: 10, sweepEveryMs: 0 })
    versions.keep("pages/a.html", Buffer.from("aaaa"))
    versions.keep("pages/b.html", Buffer.from("bbbb"))
    versions.keep("pages/c.html", Buffer.from("cccc"))
    expect(kept(root).sort()).toEqual(["bbbb", "cccc"])
  })

  it("sweeps the whole project at most once a minute (a file's own five: every time)", () => {
    const root = folder()
    const versions = new FileVersions(root, { maxBytes: 10 })
    versions.keep("pages/a.html", Buffer.from("aaaa"))
    versions.keep("pages/b.html", Buffer.from("bbbb"))
    versions.keep("pages/c.html", Buffer.from("cccc"))
    // Over the bound until the next sweep.
    expect(kept(root)).toHaveLength(3)
    for (let i = 1; i <= 6; i++) versions.keep("pages/a.html", Buffer.from(`${i}`))
    expect(kept(root).filter((v) => v.length === 1)).toHaveLength(5)
  })

  it("keeps a version even when tidying the others fails (the write isn't refused for it)", () => {
    const root = folder()
    // Another file's versions it can't read: tidying the project's fails.
    const locked = join(root, "locked")
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      expect(() => new FileVersions(root).keep("pages/a.html", Buffer.from("v1"))).not.toThrow()
    } finally {
      chmodSync(locked, 0o755)
    }
    expect(kept(root)).toEqual(["v1"])
  })
})
