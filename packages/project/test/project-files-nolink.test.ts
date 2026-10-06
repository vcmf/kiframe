import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

// A disk without hard links (exFAT, FAT, some network shares): link() isn't supported.
// A rename can fail too (a share disconnected): `failRename` makes the next one throw.
let failRename = false
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return {
    ...fs,
    linkSync: () => {
      throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" })
    },
    renameSync: (from: string, to: string) => {
      if (failRename) {
        failRename = false
        throw Object.assign(new Error("resource busy"), { code: "EBUSY" })
      }
      fs.renameSync(from, to)
    },
  }
})

const { FileRefusal, ProjectFiles } = await import("../src/project-files.ts")

describe("a disk without hard links", () => {
  it("still creates new files whole, never over an existing one", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kiframe-nolink-")), "demo.kiframe")
    mkdirSync(dir)
    const files = new ProjectFiles(dir)
    files.write("pages/a.html", "<p>a</p>", { ifHash: null })
    expect(readFileSync(join(dir, "pages", "a.html"), "utf8")).toBe("<p>a</p>")
    let refused: unknown
    try {
      files.write("pages/a.html", "<p>b</p>", { ifHash: null })
    } catch (error) {
      refused = error
    }
    expect(refused instanceof FileRefusal && refused.code).toBe("exists")
    expect(readFileSync(join(dir, "pages", "a.html"), "utf8")).toBe("<p>a</p>")
    // No temporary file left.
    expect(readdirSync(join(dir, "pages"))).toEqual(["a.html"])
  })
  it("leaves no empty file when the rename fails", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kiframe-nolink-")), "demo.kiframe")
    mkdirSync(dir)
    const files = new ProjectFiles(dir)
    files.write("pages/b.html", "<p>b</p>", { ifHash: null })
    failRename = true
    expect(() => files.write("pages/a.html", "<p>a</p>", { ifHash: null })).toThrow(FileRefusal)
    expect(readdirSync(join(dir, "pages"))).toEqual(["b.html"])
    files.write("pages/a.html", "<p>a</p>", { ifHash: null })
  })
})
