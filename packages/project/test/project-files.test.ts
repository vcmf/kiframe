import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { FILE_LIMITS, FileRefusal, ProjectFiles } from "../src/project-files.ts"

/** A project folder under the system's temp folder (on macOS, behind the /var link). */
function project(files: Record<string, string> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "kiframe-files-")), "demo.kiframe")
  mkdirSync(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const outside = mkdtempSync(join(tmpdir(), "kiframe-outside-"))
  writeFileSync(join(outside, "secret.txt"), "the user's private file")
  return { dir, outside, files: new ProjectFiles(dir) }
}

/** The refusal a call makes (its code, and its message). */
function refusal(call: () => unknown): FileRefusal {
  try {
    call()
  } catch (error) {
    if (error instanceof FileRefusal) return error
    throw error
  }
  throw new Error("expected a refusal")
}

describe("which paths", () => {
  it("refuses climbing out, absolute paths, hidden and misleading names", () => {
    const { files } = project({ "story.md": "# Demo" })
    for (const path of [
      "../secret.txt",
      "pages/../project.json",
      "/etc/passwd",
      "pages\\x.html",
      "pages/.git/config",
      "inputs/..namedfork/rsrc",
      "pages/a\u0000b.html",
      "pages/evil‮lmth.js",
      "pages/a:b.html",
      "pages/x.asar/inner.html",
      "pages//x.html",
    ]) {
      expect(refusal(() => files.read(path)).code, path).toBe("bad-path")
    }
    // Only the four areas: never the scenes, the project's settings or the takes.
    for (const path of ["project.json", "scenes/intro/scenario.yaml", "takes/x"]) {
      expect(refusal(() => files.read(path)).code, path).toBe("not-allowed")
    }
  })

  it("names areas whatever their case, always opening them as named on disk", () => {
    const { files } = project({ "story.md": "# Demo", "pages/intro/index.html": "<h1>Hi</h1>" })
    const story = files.read("STORY.md")
    expect(story).toMatchObject({ kind: "text", path: "story.md", text: "# Demo" })
    expect(files.read("Pages/intro/index.html")).toMatchObject({ path: "pages/intro/index.html" })
  })

  it("works in a project behind a link above it (the system's temp folder on macOS)", () => {
    const { dir, files } = project({ "story.md": "# Demo" })
    expect(dir.startsWith(tmpdir())).toBe(true)
    expect(files.read("story.md")).toMatchObject({ text: "# Demo" })
  })
})

describe("never through a link", () => {
  it("refuses a link as the file, in a middle folder, as the area, or dangling", () => {
    const { dir, outside, files } = project({ "pages/real/index.html": "<p>x</p>" })
    symlinkSync(join(outside, "secret.txt"), join(dir, "pages", "key.txt"))
    symlinkSync(outside, join(dir, "pages", "out"))
    mkdirSync(join(dir, "inputs"))
    symlinkSync(join(outside, "gone"), join(dir, "inputs", "dangling.txt"))
    for (const path of ["pages/key.txt", "pages/out/secret.txt", "inputs/dangling.txt"]) {
      expect(refusal(() => files.read(path)).code, path).toBe("link")
    }
    // inputs/ itself a link to a folder outside.
    const other = project()
    symlinkSync(outside, join(other.dir, "inputs"))
    expect(refusal(() => other.files.read("inputs/secret.txt")).code).toBe("link")
    expect(refusal(() => other.files.list("inputs")).code).toBe("link")
    // story.md itself a link.
    const third = project()
    symlinkSync(join(outside, "secret.txt"), join(third.dir, "story.md"))
    expect(refusal(() => third.files.read("story.md")).code).toBe("link")
    // Writes: never into a linked folder, never replacing a link.
    expect(refusal(() => files.write("pages/out/new.html", "x", { ifHash: null })).code).toBe(
      "link",
    )
    expect(refusal(() => files.write("pages/key.txt", "x", { ifHash: null })).code).toBe("link")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("the user's private file")
    expect(existsSync(join(outside, "new.html"))).toBe(false)
  })

  it("refuses a file with another hard link (it may be one outside), and a file used as a folder", () => {
    const { dir, outside, files } = project({ "pages/page.html": "<p>x</p>" })
    mkdirSync(join(dir, "inputs"))
    try {
      linkSync(join(outside, "secret.txt"), join(dir, "inputs", "hard.txt"))
    } catch {
      return // another disk: no hard link possible
    }
    expect(refusal(() => files.read("inputs/hard.txt")).code).toBe("link")
    expect(refusal(() => files.copy("inputs/hard.txt", "pages/x.txt", { ifHash: null })).code).toBe(
      "link",
    )
    expect(refusal(() => files.read("pages/page.html/rsrc")).code).toBe("not-a-file")
  })

  it("never blocks on a FIFO", () => {
    const { dir, files } = project()
    mkdirSync(join(dir, "inputs"))
    execFileSync("mkfifo", [join(dir, "inputs", "pipe.txt")])
    expect(refusal(() => files.read("inputs/pipe.txt")).code).toBe("not-a-file")
  })

  it.runIf(process.platform === "darwin")(
    "lets the kernel refuse a link swapped into a middle folder after the checks",
    () => {
      // The open itself, with the folder swapped for a link right before it (no check between).
      const { dir, outside } = project({ "pages/a/index.html": "<p>x</p>" })
      new ProjectFiles(dir) // the self-test passed: O_NOFOLLOW_ANY is in use
      renameSync(join(dir, "pages", "a"), join(dir, "pages", "a-real"))
      symlinkSync(outside, join(dir, "pages", "a"))
      const O_NOFOLLOW_ANY = 0x20000000
      const open = () =>
        openSync(join(dir, "pages", "a", "secret.txt"), constants.O_RDONLY | O_NOFOLLOW_ANY)
      expect(open).toThrow(/ELOOP/)
      // Without the flag the same open goes through (what O_NOFOLLOW alone allows).
      closeSync(
        openSync(join(dir, "pages", "a", "secret.txt"), constants.O_RDONLY | constants.O_NOFOLLOW),
      )
    },
  )
})

describe("reading", () => {
  it("gives text with its hash, a line range of it, and images as bytes", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n")
    const { dir, files } = project({ "inputs/notes.txt": lines })
    writeFileSync(join(dir, "inputs", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const whole = files.read("inputs/notes.txt")
    expect(whole).toMatchObject({ kind: "text", lines: 50, partial: false })
    const part = files.read("inputs/notes.txt", { from: 10, lines: 2 })
    expect(part).toMatchObject({ text: "line 10\nline 11", partial: true })
    // The hash is the whole file's, whatever part was returned.
    expect(part.kind === "text" && whole.kind === "text" && part.hash === whole.hash).toBe(true)
    expect(files.read("inputs/logo.png")).toMatchObject({ kind: "image", mime: "image/png" })
  })

  it("refuses a file over the size limit by its size, never reading it (a sparse one too)", () => {
    const { dir, files } = project()
    mkdirSync(join(dir, "inputs"))
    writeFileSync(join(dir, "inputs", "huge.txt"), "")
    truncateSync(join(dir, "inputs", "huge.txt"), 10 * 1024 * 1024 * 1024)
    const e = refusal(() => files.read("inputs/huge.txt"))
    expect(e.code).toBe("too-large")
  })

  it("refuses bytes that aren't text", () => {
    const { dir, files } = project()
    mkdirSync(join(dir, "inputs"))
    writeFileSync(join(dir, "inputs", "blob.bin"), Buffer.from([0xff, 0xfe, 0x00, 0xc3]))
    expect(refusal(() => files.read("inputs/blob.bin")).code).toBe("not-text")
  })

  it("lists a folder without hidden names, capped", () => {
    const { dir, files } = project({
      "pages/a.html": "a",
      "pages/.secret": "x",
      "pages/.0a1b2c3d4e5f.tmp": "t",
    })
    expect(files.list("pages").entries.map((e) => e.name)).toEqual(["a.html"])
    // pages/ not made yet: empty.
    expect(project().files.list("pages")).toMatchObject({ entries: [], truncated: false })
    mkdirSync(join(dir, "inputs"))
    for (let i = 0; i <= FILE_LIMITS.listEntries; i++)
      writeFileSync(join(dir, "inputs", `f${i}.txt`), "")
    expect(files.list("inputs")).toMatchObject({ truncated: true })
    expect(files.list("inputs").entries).toHaveLength(FILE_LIMITS.listEntries)
  })
})

describe("writing", () => {
  it("creates a file only if it's new, replaces it only with the hash it was read with", () => {
    const { dir, files } = project()
    const made = files.write("pages/intro/index.html", "<h1>One</h1>", { ifHash: null })
    expect(readFileSync(join(dir, "pages", "intro", "index.html"), "utf8")).toBe("<h1>One</h1>")
    // Again as new: it exists.
    expect(refusal(() => files.write("pages/intro/index.html", "x", { ifHash: null })).code).toBe(
      "exists",
    )
    // Replaced with the hash it was written (or read) with.
    const read = files.read("pages/intro/index.html")
    expect(read.hash).toBe(made.hash)
    files.write("pages/intro/index.html", "<h1>Two</h1>", { ifHash: read.hash })
    // The user edits it meanwhile: the agent's write with the old hash is refused, the edit kept.
    writeFileSync(join(dir, "pages", "intro", "index.html"), "<h1>The user's</h1>")
    const stale = refusal(() =>
      files.write("pages/intro/index.html", "<h1>Three</h1>", { ifHash: read.hash }),
    )
    expect(stale.code).toBe("changed")
    expect(readFileSync(join(dir, "pages", "intro", "index.html"), "utf8")).toBe(
      "<h1>The user's</h1>",
    )
    // No temporary file left behind.
    expect(files.list("pages/intro").entries.map((e) => e.name)).toEqual(["index.html"])
  })

  it("writes story.md within its length, and nothing in inputs/ or templates", () => {
    const { files } = project()
    files.write("story.md", "# Story", { ifHash: null })
    const long = "é".repeat(FILE_LIMITS.storyChars + 1)
    expect(refusal(() => files.write("story.md", long, { ifHash: null })).code).toBe("too-large")
    // Characters, not bytes: 8,000 accented letters (16,000 bytes) fit.
    const story = files.read("story.md")
    files.write("story.md", "é".repeat(FILE_LIMITS.storyChars), { ifHash: story.hash })
    expect(refusal(() => files.write("inputs/x.txt", "x", { ifHash: null })).code).toBe("read-only")
    expect(refusal(() => files.write("pages", "x", { ifHash: null })).code).toBe("not-a-file")
  })

  it("writes pages as text only, within their sizes", () => {
    const { files } = project()
    expect(refusal(() => files.write("pages/run.command", "rm -rf ~", { ifHash: null })).code).toBe(
      "not-allowed",
    )
    const big = "x".repeat(FILE_LIMITS.pageFileBytes + 1)
    expect(refusal(() => files.write("pages/big.html", big, { ifHash: null })).code).toBe(
      "too-large",
    )
  })

  it("refuses a new name the disk would take for another file's (case, accents)", () => {
    const { dir, files } = project({ "pages/Logo.svg": "<svg/>" })
    // A case-sensitive disk keeps both: nothing to refuse there.
    let caseInsensitive = false
    try {
      readFileSync(join(dir, "pages", "LOGO.SVG"))
      caseInsensitive = true
    } catch {
      // case-sensitive
    }
    if (caseInsensitive) {
      expect(refusal(() => files.write("pages/logo.svg", "<svg/>", { ifHash: null })).code).toBe(
        "collision",
      )
    }
  })
})

describe("what review round 1 found", () => {
  it("returns a whole file unless a range is asked, and says when any of it is left out", () => {
    const short = Array.from({ length: 3000 }, (_, i) => `l${i}`).join("\n")
    const { dir, files } = project({ "pages/app.js": short })
    const whole = files.read("pages/app.js")
    expect(whole).toMatchObject({ lines: 3000, partial: false })
    expect(whole.kind === "text" && whole.text).toBe(short)
    // Over the return cap: cut at a line (never inside a character), said partial.
    const long = Array.from({ length: 4000 }, () => "é".repeat(20)).join("\n")
    writeFileSync(join(dir, "pages", "long.txt"), long)
    const cut = files.read("pages/long.txt")
    expect(cut).toMatchObject({ partial: true, lines: 4000 })
    expect(cut.kind === "text" && cut.text.split("\n").every((l) => l === "é".repeat(20))).toBe(
      true,
    )
  })

  it("writes back a file stored with a decomposed name, read by its composed spelling", () => {
    const { dir, files } = project({ "pages/x.html": "x" })
    writeFileSync(join(dir, "pages", "cafe\u0301.html"), "<p>caf\u00e9</p>")
    let read
    try {
      read = files.read("pages/caf\u00e9.html")
    } catch {
      return // a disk that tells the two forms apart: nothing to show
    }
    files.write("pages/caf\u00e9.html", "<p>new</p>", { ifHash: read.hash })
    expect(files.read("pages/caf\u00e9.html")).toMatchObject({ text: "<p>new</p>" })
  })

  it("says a file-system error by its code, never an absolute path", () => {
    const { dir, files } = project({ "pages/locked/x.html": "x" })
    chmodSync(join(dir, "pages", "locked"), 0o000)
    try {
      const e = refusal(() => files.list("pages/locked"))
      expect(e.code).toBe("io")
      expect(e.message).not.toContain(dir)
      expect(e.message).not.toContain(tmpdir())
    } finally {
      chmodSync(join(dir, "pages", "locked"), 0o755)
    }
  })

  it("refuses a link on a write's way before walking anything for its size", () => {
    const { dir, outside, files } = project({ "pages/x.html": "x" })
    // An outside folder too big to walk: walked first, the write would fail on its size.
    mkdirSync(join(outside, "many"))
    for (let i = 0; i <= FILE_LIMITS.walkEntries; i++)
      writeFileSync(join(outside, "many", `f${i}`), "")
    symlinkSync(join(outside, "many"), join(dir, "pages", "demo"))
    expect(refusal(() => files.write("pages/demo/x.html", "x", { ifHash: null })).code).toBe("link")
    // Off the write's way, the size walk never goes through it either (a write elsewhere works).
    files.write("pages/next.html", "<p>x</p>", { ifHash: null })
  })

  it("copies text files within a page file's limit (images and fonts within an image's)", () => {
    const { dir, files } = project()
    mkdirSync(join(dir, "inputs"))
    writeFileSync(join(dir, "inputs", "big.js"), "x".repeat(FILE_LIMITS.pageFileBytes + 1))
    expect(refusal(() => files.copy("inputs/big.js", "pages/app.js", { ifHash: null })).code).toBe(
      "too-large",
    )
  })

  it("counts a replaced file once (a full pages/ still takes edits)", () => {
    const { dir, files } = project()
    mkdirSync(join(dir, "pages", "many"), { recursive: true })
    for (let i = 0; i < FILE_LIMITS.pagesFiles - 1; i++)
      writeFileSync(join(dir, "pages", "many", `f${i}.txt`), "")
    const last = files.write("pages/last.html", "<p>1</p>", { ifHash: null })
    files.write("pages/last.html", "<p>2</p>", { ifHash: last.hash })
    expect(refusal(() => files.write("pages/one-more.html", "x", { ifHash: null })).code).toBe(
      "too-large",
    )
  })

  it("never writes into a folder named like another but for case, and leaves no folder it made", () => {
    const { dir, files } = project({ "pages/demo/index.html": "x" })
    let caseInsensitive = false
    try {
      readFileSync(join(dir, "pages", "DEMO", "index.html"))
      caseInsensitive = true
    } catch {
      // case-sensitive
    }
    if (caseInsensitive) {
      expect(refusal(() => files.write("pages/Demo/new.html", "x", { ifHash: null })).code).toBe(
        "collision",
      )
    }
    // A write refused after its folders were made (nothing to replace): none left behind.
    expect(refusal(() => files.write("pages/a/b/c/x.html", "x", { ifHash: "stale" })).code).toBe(
      "not-found",
    )
    expect(existsSync(join(dir, "pages", "a"))).toBe(false)
  })
})

describe("what review round 2 found", () => {
  it("keeps one page folder under 20 MB, the other pages aside", () => {
    const { dir, files } = project({ "pages/site/index.html": "<p>x</p>" })
    // A sparse file: its size counts, no 20 MB is written.
    writeFileSync(join(dir, "pages", "site", "video.webm"), "")
    truncateSync(join(dir, "pages", "site", "video.webm"), FILE_LIMITS.pageFolderBytes)
    expect(
      refusal(() => files.write("pages/site/more.html", "<p>x</p>", { ifHash: null })).message,
    ).toContain("20 MB")
    files.write("pages/other/index.html", "<p>x</p>", { ifHash: null })
  })

  it("refuses a path with more than 16 parts", () => {
    const { files } = project()
    const deep = `pages/${"a/".repeat(FILE_LIMITS.segments - 1)}x.html`
    expect(refusal(() => files.write(deep, "<p>x</p>", { ifHash: null })).code).toBe("bad-path")
  })

  it("cuts a single huge line (a minified file) to the return limit, whole characters, said partial", () => {
    const line = "é".repeat(150 * 1024)
    const { files } = project({ "pages/app.min.js": line })
    const read = files.read("pages/app.min.js")
    expect(read.kind === "text" && Buffer.byteLength(read.text)).toBeLessThanOrEqual(
      FILE_LIMITS.textReturnBytes,
    )
    expect(read.kind === "text" && /^é+$/.test(read.text)).toBe(true)
    expect(read).toMatchObject({ partial: true })
  })

  it("refuses a range that isn't whole numbers from 1 (never an empty read said complete)", () => {
    const { files } = project({ "pages/a.html": "a\nb" })
    for (const range of [
      { from: Number.NaN, lines: 1 },
      { from: 0, lines: 1 },
      { from: 1, lines: 0.5 },
    ]) {
      expect(refusal(() => files.read("pages/a.html", range)).code).toBe("bad-path")
    }
  })

  it("sweeps a temporary file an interrupted write left (its page readable again)", () => {
    const { dir, files: before } = project({ "pages/a/index.html": "<p>x</p>" })
    // A crash between linking a new file into place and removing its temporary name.
    linkSync(join(dir, "pages", "a", "index.html"), join(dir, "pages", "a", ".0123456789ab.tmp"))
    expect(refusal(() => before.read("pages/a/index.html")).code).toBe("link")
    // The project opened again: swept.
    const files = new ProjectFiles(dir)
    expect(files.read("pages/a/index.html")).toMatchObject({ text: "<p>x</p>" })
    expect(existsSync(join(dir, "pages", "a", ".0123456789ab.tmp"))).toBe(false)
  })

  it("writes into a Pages/ folder the user made, and keeps a replaced file's name as on disk", () => {
    const { dir } = project()
    mkdirSync(join(dir, "Pages"))
    writeFileSync(join(dir, "Pages", "Logo.svg"), "<svg/>")
    const files = new ProjectFiles(dir)
    try {
      readFileSync(join(dir, "pages", "logo.svg"))
    } catch {
      return // a case-sensitive disk: pages/ is another folder there
    }
    files.write("pages/new.html", "<p>x</p>", { ifHash: null })
    const read = files.read("pages/LOGO.svg")
    files.write("pages/LOGO.svg", "<svg id='new'/>", { ifHash: read.hash })
    expect(files.list("pages").entries.map((e) => e.name)).toEqual(["Logo.svg", "new.html"])
  })

  it("doesn't count hidden entries the agent can't see (a page folder's .git)", () => {
    const { dir, files } = project()
    mkdirSync(join(dir, "pages", "site", ".git"), { recursive: true })
    for (let i = 0; i <= FILE_LIMITS.walkEntries; i++)
      writeFileSync(join(dir, "pages", "site", ".git", `o${i}`), "")
    files.write("pages/site/index.html", "<p>x</p>", { ifHash: null })
  })

  // macOS only: elsewhere such a swap during an open is a stated residual (no kernel flag).
  it.runIf(process.platform === "darwin")(
    "refuses a link swapped into a middle folder at the open itself (the kernel's check)",
    () => {
      const { dir, outside } = project({ "pages/a/index.html": "<p>x</p>" })
      writeFileSync(join(outside, "index.html"), "outside")
      let swapped = false
      const files = new ProjectFiles(dir, {
        beforeOpen: () => {
          if (swapped) return
          swapped = true
          renameSync(join(dir, "pages", "a"), join(dir, "pages", "a-real"))
          symlinkSync(outside, join(dir, "pages", "a"))
        },
      })
      const e = refusal(() => files.read("pages/a/index.html"))
      expect(e.code).toBe("link")
      expect(e.message).not.toContain("outside")
    },
  )

  it("never blocks on a FIFO swapped in at the open", () => {
    const { dir } = project({ "pages/a.html": "<p>x</p>" })
    let swapped = false
    const files = new ProjectFiles(dir, {
      beforeOpen: (abs) => {
        if (swapped || !abs.endsWith("a.html")) return
        swapped = true
        unlinkSync(abs)
        execFileSync("mkfifo", [abs])
      },
    })
    expect(refusal(() => files.read("pages/a.html")).code).toBe("not-a-file")
  })
})

describe("copying and deleting", () => {
  it("copies into pages/ only the types a page uses, as bytes", () => {
    const { dir, files } = project()
    mkdirSync(join(dir, "inputs"))
    writeFileSync(join(dir, "inputs", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))
    writeFileSync(join(dir, "inputs", "script.txt"), "echo hi")
    files.copy("inputs/logo.png", "pages/intro/logo.png", { ifHash: null })
    expect([...readFileSync(join(dir, "pages", "intro", "logo.png"))]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d,
    ])
    for (const to of ["pages/run.command", "pages/x.sh", "pages/app.app", "pages/x.webloc"]) {
      expect(refusal(() => files.copy("inputs/script.txt", to, { ifHash: null })).code, to).toBe(
        "not-allowed",
      )
    }
    expect(
      refusal(() => files.copy("inputs/logo.png", "inputs/copy.png", { ifHash: null })).code,
    ).toBe("read-only")
  })

  it("deletes a file in pages/ (with the hash it was read with), never pages/ itself", () => {
    const { dir, files } = project()
    const made = files.write("pages/old/index.html", "<p>old</p>", { ifHash: null })
    expect(refusal(() => files.delete("pages/old/index.html", { ifHash: "nope" })).code).toBe(
      "changed",
    )
    files.delete("pages/old/index.html", { ifHash: made.hash })
    // Its emptied folder went with it; pages/ stayed.
    expect(existsSync(join(dir, "pages", "old"))).toBe(false)
    expect(existsSync(join(dir, "pages"))).toBe(true)
    expect(refusal(() => files.delete("pages", { ifHash: made.hash })).code).toBe("read-only")
    expect(refusal(() => files.delete("story.md", { ifHash: made.hash })).code).toBe("read-only")
  })
})

describe("what the agent is told", () => {
  it("never names an absolute path", () => {
    const { dir, files } = project()
    const messages = [
      refusal(() => files.read("pages/missing.html")).message,
      refusal(() => files.read("project.json")).message,
      refusal(() => files.write("inputs/x.txt", "x", { ifHash: null })).message,
    ]
    for (const m of messages) {
      expect(m).not.toContain(dir)
      expect(m).not.toContain(tmpdir())
    }
  })
})

describe("what review round 3 found", () => {
  it("never hashes a hard-linked file for a write or a delete (no test of a guess at it)", () => {
    const { dir, outside, files } = project()
    mkdirSync(join(dir, "pages"))
    linkSync(join(outside, "secret.txt"), join(dir, "pages", "x.txt"))
    const guess = createHash("sha256").update("the user's private file").digest("hex")
    expect(refusal(() => files.write("pages/x.txt", "x", { ifHash: guess })).code).toBe("link")
    expect(refusal(() => files.delete("pages/x.txt", { ifHash: guess })).code).toBe("link")
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("the user's private file")
  })

  it("names the folder's spelling on disk when the agent's differs only by case", () => {
    const { dir, files } = project({ "pages/intro/index.html": "<p>x</p>" })
    try {
      readFileSync(join(dir, "pages", "INTRO", "index.html"))
    } catch {
      return // a case-sensitive disk: another folder there
    }
    const read = files.read("pages/Intro/index.html")
    expect(
      refusal(() => files.write("pages/Intro/index.html", "<p>y</p>", { ifHash: read.hash }))
        .message,
    ).toContain("named intro")
  })

  it("counts lines as an editor does (a final newline ends the last one) and keeps it", () => {
    const { files } = project({ "story.md": "# Demo\nintro\n" })
    const whole = files.read("story.md")
    expect(whole.kind === "text" && [whole.lines, whole.text, whole.partial]).toEqual([
      2,
      "# Demo\nintro\n",
      false,
    ])
    const last = files.read("story.md", { from: 2, lines: 1 })
    expect(last.kind === "text" && last.text).toBe("intro\n")
  })

  it("keeps a byte-order mark in the text read (a write back keeps the file's bytes)", () => {
    const { dir, files } = project({ "pages/a.txt": "\uFEFFhello" })
    const read = files.read("pages/a.txt")
    if (read.kind !== "text") throw new Error("text expected")
    files.write("pages/a.txt", read.text, { ifHash: read.hash })
    expect(files.read("pages/a.txt").hash).toBe(read.hash)
    expect(readFileSync(join(dir, "pages", "a.txt"))[0]).toBe(0xef)
  })
})

describe("editing, checking and keeping (C2)", () => {
  it("replaces one exact passage of the whole file, the rest byte for byte (a long page, CRLF, a BOM)", () => {
    const long = `\uFEFF<p>start</p>\r\n${"<p>filler</p>\r\n".repeat(20_000)}<p>end</p>\r\n`
    const { dir, files } = project({ "pages/a.html": long })
    const read = files.read("pages/a.html")
    const result = files.edit("pages/a.html", "<p>end</p>", "<p>fin</p>", { ifHash: read.hash })
    const after = readFileSync(join(dir, "pages", "a.html"), "utf8")
    expect(after).toBe(long.replace("<p>end</p>", "<p>fin</p>"))
    expect(Buffer.byteLength(after)).toBeGreaterThan(FILE_LIMITS.textReturnBytes)
    expect(result.line).toBe(20_002)
  })

  it("refuses a passage that isn't there, or is there more than once, or a stale hash", () => {
    const { files } = project({ "pages/a.html": "<p>x</p><p>x</p>" })
    const { hash } = files.read("pages/a.html")
    expect(refusal(() => files.edit("pages/a.html", "<p>y</p>", "z", { ifHash: hash })).code).toBe(
      "no-match",
    )
    expect(
      refusal(() => files.edit("pages/a.html", "<p>x</p>", "z", { ifHash: hash })).message,
    ).toMatch(/2 times/)
    expect(
      refusal(() => files.edit("pages/a.html", "<p>x</p><p>x", "z", { ifHash: "0".repeat(64) }))
        .code,
    ).toBe("changed")
  })

  it("lets the caller's check refuse the whole result (an edit or a text copy), writing nothing", () => {
    const { dir, files } = project({
      "pages/a.html": "<p>hello</p>",
      "inputs/notes.txt": "key: hunter2-secret",
    })
    const check = (text: string) => (text.includes("hunter2") ? "holds a secret" : undefined)
    const { hash } = files.read("pages/a.html")
    // The value only appears once both pieces are there: the whole result is checked.
    files.edit("pages/a.html", "hello", "hunter", { ifHash: hash, check })
    const next = files.read("pages/a.html").hash
    expect(
      refusal(() => files.edit("pages/a.html", "hunter", "hunter2", { ifHash: next, check })).code,
    ).toBe("refused")
    expect(readFileSync(join(dir, "pages", "a.html"), "utf8")).toBe("<p>hunter</p>")
    expect(
      refusal(() => files.copy("inputs/notes.txt", "pages/notes.txt", { ifHash: null, check }))
        .code,
    ).toBe("refused")
    // Text under an image's name is checked all the same.
    expect(
      refusal(() => files.copy("inputs/notes.txt", "pages/notes.png", { ifHash: null, check }))
        .code,
    ).toBe("refused")
  })

  it("lets the caller's guard refuse an edit before the passage is looked for", () => {
    const { files } = project({ "pages/a.html": "<p>pw: hunter2-secret</p>" })
    const guard = (text: string) => (text.includes("hunter2") ? "holds a secret" : undefined)
    const { hash } = files.read("pages/a.html")
    // The same answer whether the passage is in it or not: never an answer about its content.
    for (const old of ["pw: h", "pw: z"]) {
      expect(
        refusal(() => files.edit("pages/a.html", old, old, { ifHash: hash, guard })).code,
      ).toBe("guarded")
    }
  })

  it("says a file's hash and size without its bytes, and a path's canonical form", () => {
    const { files } = project({ "pages/font.woff": "\u0000\u0001binary" })
    const stat = files.stat("Pages/font.woff")
    expect(stat).toMatchObject({ path: "pages/font.woff", size: 8 })
    expect(stat.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(files.canonical("PAGES/x/y.html")).toBe("pages/x/y.html")
    expect(refusal(() => files.canonical("project.json")).code).toBe("not-allowed")
  })

  it("scrubs the whole file before a part is cut (a value across lines, or across the cut)", () => {
    const { files } = project({ "story.md": "a\ncorrect horse\nbattery staple\nb" })
    const scrub = (t: string) => t.replace(/correct horse\s*battery staple/g, "[secret]")
    // Line by line, neither half of the value shows.
    for (const from of [2, 3]) {
      const part = files.read("story.md", { from, lines: 1 }, scrub)
      expect(part).toMatchObject({ kind: "text", scrubbed: true })
      expect(part.kind === "text" && part.text).not.toMatch(/horse|battery/)
    }
    expect(files.read("story.md", undefined, scrub)).toMatchObject({ text: "a\n[secret]\nb" })
  })

  it("refuses an edit whose passage is in the file twice, overlapping", () => {
    const { files } = project({ "pages/a.html": "<b>aaa</b>" })
    const { hash } = files.read("pages/a.html")
    expect(refusal(() => files.edit("pages/a.html", "aa", "x", { ifHash: hash })).message).toMatch(
      /2 times/,
    )
  })

  it("keeps a file's bytes before replacing or deleting it, and changes nothing if they can't be kept", () => {
    const kept: [string, string][] = []
    const dir = project({ "pages/a.html": "v1" }).dir
    const files = new ProjectFiles(dir, {
      keep: (path, bytes) => kept.push([path, Buffer.from(bytes).toString("utf8")]),
    })
    files.write("pages/a.html", "v2", { ifHash: files.read("pages/a.html").hash })
    files.delete("pages/a.html", { ifHash: files.read("pages/a.html").hash })
    expect(kept).toEqual([
      ["pages/a.html", "v1"],
      ["pages/a.html", "v2"],
    ])
    files.write("pages/b.html", "b", { ifHash: null })
    const failing = new ProjectFiles(dir, {
      keep: () => {
        throw Object.assign(
          new Error("ENOSPC: no space left on device, open '/Users/someone/Library/Kiframe/v.bin'"),
          { code: "ENOSPC" },
        )
      },
    })
    const said = refusal(() =>
      failing.delete("pages/b.html", { ifHash: failing.read("pages/b.html").hash }),
    ).message
    expect(said).toMatch(/couldn't be kept first \(ENOSPC\).*nothing changed/)
    // Its code only: never a path in the app's data (the user's name) to the model.
    expect(said).not.toContain("/Users/")
    expect(readFileSync(join(dir, "pages", "b.html"), "utf8")).toBe("b")
  })
})
