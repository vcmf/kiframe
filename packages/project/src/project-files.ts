// The project's files the agent may see (OBJECT-MODEL §0.13): story.md, pages/ (read and written),
// inputs/ and Kiframe's templates (read only), never anything else. The agent may be steered by a
// web page, and a project folder may come from someone else: every path is checked, no link is
// ever followed (macOS: the kernel refuses one anywhere in a path, O_NOFOLLOW_ANY), writes are
// whole or nothing and never over a change made since the caller read the file.
// Residual (stated): another local process swapping a folder for a link between our checks and a
// rename / mkdir / unlink, or a listing (Node has no renameat, and opendir takes no flags: a
// listing could name, never read, another folder's files); elsewhere than macOS, opens check each
// folder in turn (no kernel flag), so such a swap during an open isn't excluded either. And a
// change saved in the moment between a write's hash check and its rename is replaced (no lock
// between processes: the window is that of one rename).
import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { removeStrayTemps, syncFolder, tempName } from "./files.ts"

/** Why a file call was refused: a code to branch on, a message the agent can act on. */
export type FileRefusalCode =
  | "bad-path"
  | "not-allowed"
  | "read-only"
  | "link"
  | "not-a-file"
  | "not-text"
  | "too-large"
  | "changed"
  | "exists"
  | "not-found"
  | "collision"
  | "io"

export class FileRefusal extends Error {
  readonly code: FileRefusalCode
  constructor(code: FileRefusalCode, message: string) {
    super(message)
    this.name = "FileRefusal"
    this.code = code
  }
}

/** A folder's entry, as listed (dot-names never are). */
export interface FileEntry {
  name: string
  kind: "file" | "folder"
  size: number
}

export type FileRead =
  | {
      kind: "text"
      /** The canonical path (its area named as on disk). */
      path: string
      text: string
      /** The file's content hash (sha256 of its bytes, hex): what a write is checked against. */
      hash: string
      lines: number
      /** Only part of the file was returned (`range`, or the return cap). */
      partial: boolean
    }
  | { kind: "image"; path: string; bytes: Uint8Array; mime: string; hash: string }

/** The limits (OBJECT-MODEL §0.13, design review 2026-10-06). */
export const FILE_LIMITS = {
  /** story.md, in characters (code points). */
  storyChars: 8000,
  /** A text file written in pages/. */
  pageFileBytes: 512 * 1024,
  /** A page's folder (pages/<name>/), every file in it. */
  pageFolderBytes: 20 * 1024 * 1024,
  /** All of pages/. */
  pagesBytes: 100 * 1024 * 1024,
  pagesFiles: 2000,
  /** A text file read (any area): larger is refused, never scanned. */
  textReadBytes: 1024 * 1024,
  /** Text returned by one read (a longer file: by line range). */
  textReturnBytes: 100 * 1024,
  rangeLines: 2000,
  imageBytes: 10 * 1024 * 1024,
  listEntries: 1000,
  /** A folder walk (sizes): deeper or wider is refused. */
  walkDepth: 16,
  walkEntries: 5000,
  segments: 16,
  segmentBytes: 255,
} as const

const TEXT_WRITE = new Set(["html", "htm", "css", "js", "mjs", "json", "svg", "md", "txt"])
const COPY_TO = new Set([
  ...TEXT_WRITE,
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "woff",
  "woff2",
  "ttf",
  "otf",
])
const IMAGES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

type Area = "story" | "pages" | "inputs" | "templates"

/** A checked path: its area, its segments under the area, its canonical form. */
interface Resolved {
  area: Area
  /** Segments under the area root (none: the area itself; story.md has none). */
  rest: string[]
  canonical: string
}

/** macOS: the kernel refuses a symbolic link anywhere in the path (macOS 11+; not in fs.constants). */
const O_NOFOLLOW_ANY = 0x20000000
let noFollowAnyChecked: boolean | undefined

/**
 * Whether opens can rely on O_NOFOLLOW_ANY: on macOS, checked once by opening through a link (it
 * must be refused). Failing that on macOS, every open is refused (fails closed).
 */
function noFollowAny(): boolean {
  if (process.platform !== "darwin") return false
  if (noFollowAnyChecked === undefined) {
    // (A self-test that can't run, an unwritable temp folder: off as well, never retried.)
    noFollowAnyChecked = false
    let dir: string | undefined
    try {
      dir = realpathSync(mkdtempSync(join(tmpdir(), "kiframe-nofollow-")))
      mkdirSync(join(dir, "real"))
      symlinkSync(join(dir, "real"), join(dir, "link"))
      closeSync(openSync(join(dir, "link"), constants.O_RDONLY | O_NOFOLLOW_ANY))
    } catch (error) {
      noFollowAnyChecked = dir !== undefined && (error as NodeJS.ErrnoException).code === "ELOOP"
    } finally {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
  }
  if (!noFollowAnyChecked) {
    throw new FileRefusal(
      "io",
      "this system can't open files without following links: file access is off",
    )
  }
  return true
}

/** One segment of a path the agent may name: never one that hides, climbs or misleads. */
function checkSegment(segment: string): string | undefined {
  if (segment === "" || segment === "." || segment === "..") return "an empty, `.` or `..` part"
  if (segment.startsWith(".")) return "a name starting with `.` (hidden files)"
  if (/[\\:]/.test(segment)) return "a `\\` or `:`"
  if (/[\p{Cc}\p{Cf}]/u.test(segment)) return "a control or invisible character"
  if (Buffer.byteLength(segment) > FILE_LIMITS.segmentBytes) return "a name over 255 bytes"
  if (segment.toLowerCase().endsWith(".asar")) return "an `.asar` name"
  return undefined
}

/** The confined file access of one project folder (and, read only, Kiframe's templates). */
export class ProjectFiles {
  readonly #root: string
  readonly #templates: string | undefined
  readonly #dev: number
  /** Tests only: runs right before each open (a folder swapped for a link, a FIFO, at that moment). */
  readonly #beforeOpen: ((abs: string) => void) | undefined

  /**
   * `projectDir`: the project's folder (its real path is taken: links above it are the user's).
   * Our own temporary files left in pages/ by an interrupted write are swept.
   */
  constructor(
    projectDir: string,
    options: { templates?: string; beforeOpen?: (abs: string) => void } = {},
  ) {
    this.#root = realpathSync(projectDir)
    this.#templates = options.templates === undefined ? undefined : realpathSync(options.templates)
    this.#dev = lstatSync(this.#root).dev
    this.#beforeOpen = options.beforeOpen
    // Checked now; without it, the project opens and each file call is refused (never followed).
    try {
      noFollowAny()
    } catch {
      // said by each call
    }
    try {
      if (lstatSync(join(this.#root, "pages")).isDirectory()) {
        removeStrayTemps(join(this.#root, "pages"), true)
      }
    } catch {
      // no pages/ yet
    }
  }

  // ── Paths ─────────────────────────────────────────────────────────────────────────────────

  /** A path the agent named, checked: its area, its parts, its canonical form; or a refusal. */
  #resolve(path: string): Resolved {
    if (typeof path !== "string" || path.includes("\0") || path.startsWith("/")) {
      throw new FileRefusal("bad-path", "a path is relative to the project (no leading `/`)")
    }
    // As written (a disk that tells Unicode forms apart finds a name as it was listed); the area's
    // name alone is matched loosely.
    const segments = path.split("/")
    if (segments.at(-1) === "" && segments.length > 1) segments.pop() // a trailing `/`
    if (segments.length > FILE_LIMITS.segments) {
      throw new FileRefusal("bad-path", `a path has at most ${FILE_LIMITS.segments} parts`)
    }
    for (const segment of segments) {
      const why = checkSegment(segment)
      if (why !== undefined) throw new FileRefusal("bad-path", `${path}: ${why} isn't allowed`)
    }
    const [first = "", ...rest] = segments
    const area = first.normalize("NFC").toLowerCase()
    if (area === "story.md" && rest.length === 0) {
      return { area: "story", rest: [], canonical: "story.md" }
    }
    if (area === "pages" || area === "inputs" || area === "templates") {
      if (area === "templates" && this.#templates === undefined) {
        throw new FileRefusal("not-found", "there are no templates")
      }
      return { area, rest, canonical: [area, ...rest].join("/") }
    }
    throw new FileRefusal(
      "not-allowed",
      `${path}: only story.md, pages/, inputs/ and templates/ can be used (the scenes and the project's settings have their own tools)`,
    )
  }

  /** The absolute path of a resolved one (its area by its literal name on disk). */
  #absolute(r: Resolved): string {
    if (r.area === "story") return join(this.#root, "story.md")
    const base = r.area === "templates" ? (this.#templates as string) : join(this.#root, r.area)
    return join(base, ...r.rest)
  }

  /**
   * Each existing part from the area's root down, checked: a real folder (never a link, a file in
   * the middle, another device), the last one what it may be. Good messages; the open's own
   * checks are what's relied on.
   */
  #walk(r: Resolved, last: "file" | "folder" | "absent-ok"): Stats | undefined {
    const parts =
      r.area === "story" ? ["story.md"] : r.area === "templates" ? r.rest : [r.area, ...r.rest]
    let at = r.area === "templates" ? (this.#templates as string) : this.#root
    let stat: Stats | undefined = lstatSync(at)
    for (const [i, part] of parts.entries()) {
      at = join(at, part)
      const isLast = i === parts.length - 1
      try {
        stat = lstatSync(at)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw this.#io(error, r, "check")
        // Absent (the file, or a folder on its way: made by the write).
        if (last === "absent-ok") return undefined
        throw new FileRefusal("not-found", `${r.canonical} doesn't exist`)
      }
      if (stat.isSymbolicLink()) {
        throw new FileRefusal("link", `${r.canonical}: links are never followed`)
      }
      if (stat.dev !== this.#dev && r.area !== "templates") {
        throw new FileRefusal(
          "not-allowed",
          `${r.canonical}: on another disk (a mount inside the project)`,
        )
      }
      const want = isLast ? (last === "folder" ? "folder" : "file") : "folder"
      if (want === "folder" ? !stat.isDirectory() : !stat.isFile()) {
        throw new FileRefusal(
          "not-a-file",
          isLast && want === "file"
            ? `${r.canonical} isn't a regular file`
            : `${r.canonical}: ${parts.slice(0, i + 1).join("/")} isn't a folder`,
        )
      }
    }
    return stat
  }

  /**
   * Opens a file, no link followed anywhere (macOS: the kernel; elsewhere: each folder checked,
   * the file itself with O_NOFOLLOW), never blocking (a FIFO swapped in), then checked from its
   * descriptor: a regular file on the project's disk.
   */
  #open(abs: string, r: Resolved, flags: number, mode?: number): number {
    const all =
      flags | constants.O_NONBLOCK | (noFollowAny() ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW)
    let fd: number
    this.#beforeOpen?.(abs)
    try {
      fd = mode === undefined ? openSync(abs, all) : openSync(abs, all, mode)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ELOOP")
        throw new FileRefusal("link", `${r.canonical}: links are never followed`)
      if (code === "ENOENT") throw new FileRefusal("not-found", `${r.canonical} doesn't exist`)
      if (code === "EEXIST") throw new FileRefusal("exists", `${r.canonical} already exists`)
      throw this.#io(error, r, "open")
    }
    const stat = fstatSync(fd)
    if (!stat.isFile() || (stat.dev !== this.#dev && r.area !== "templates")) {
      closeSync(fd)
      throw new FileRefusal("not-a-file", `${r.canonical} isn't a regular file`)
    }
    return fd
  }

  /** A refusal for a file-system error: its code only (never an absolute path). */
  #io(error: unknown, r: Resolved, what: string): FileRefusal {
    const code = (error as NodeJS.ErrnoException).code ?? "an error"
    return new FileRefusal("io", `couldn't ${what} ${r.canonical} (${code})`)
  }

  // ── The calls (every file-system error said by its code: never an absolute path) ─────────────

  /**
   * A file the agent may read: text (UTF-8; a line range of a long one), or an image as bytes.
   * Every read gives the file's hash: what a later write is checked against.
   */
  read(path: string, range?: { from: number; lines: number }): FileRead {
    return safe("read", path, () => this.#readUnsafe(path, range))
  }

  /** A folder's entries the agent may see (never a dot-name: hidden files, our temporary ones). */
  list(path: string): { path: string; entries: FileEntry[]; truncated: boolean } {
    return safe("list", path, () => this.#listUnsafe(path))
  }

  /**
   * Writes a whole text file (story.md, or a text file in pages/). `ifHash`: the hash the caller
   * read (the file unchanged since), or `null` (the file must not exist). Whole or not at all.
   */
  write(
    path: string,
    text: string,
    opts: { ifHash: string | null },
  ): { path: string; hash: string } {
    return safe("write", path, () => this.#writeUnsafe(path, text, opts))
  }

  /**
   * Copies a file into pages/ (from inputs/, pages/ or the templates): how an image or a font gets
   * into a page (the model never writes binary). Only types a page uses (never one that runs).
   */
  copy(from: string, to: string, opts: { ifHash: string | null }): { path: string; hash: string } {
    return safe("copy into", to, () => this.#copyUnsafe(from, to, opts))
  }

  /** Deletes a file in pages/ (its emptied folders with it, never pages/ itself). */
  delete(path: string, opts: { ifHash: string }): { path: string } {
    return safe("delete", path, () => this.#deleteUnsafe(path, opts))
  }

  // ── Reading ───────────────────────────────────────────────────────────────────────────────

  /** A file's bytes, through an open descriptor, never more than `cap` (a file that grows: refused). */
  #readAll(r: Resolved, cap: number, forCopy = false): { bytes: Uint8Array; hash: string } {
    this.#walk(r, "file")
    const fd = this.#open(this.#absolute(r), r, constants.O_RDONLY)
    try {
      const stat = fstatSync(fd)
      // A file with another hard link may be one outside the project (never read through).
      if (stat.nlink > 1) {
        throw new FileRefusal(
          "link",
          `${r.canonical}: a file with several hard links is never read`,
        )
      }
      if (stat.size > cap) {
        throw new FileRefusal(
          "too-large",
          `${r.canonical} is ${stat.size} bytes: over the ${cap}-byte limit${forCopy ? " for a copy" : ""}`,
        )
      }
      // One byte past the size (a file that grew since: refused rather than read on).
      const bytes = Buffer.alloc(Math.min(stat.size, cap) + 1)
      let length = 0
      for (;;) {
        if (length === bytes.length) {
          throw new FileRefusal("too-large", `${r.canonical} grew as it was read: read it again`)
        }
        const n = readSync(fd, bytes, length, bytes.length - length, null)
        if (n === 0) break
        length += n
      }
      const content = bytes.subarray(0, length)
      return { bytes: new Uint8Array(content), hash: hashOf(content) }
    } finally {
      closeSync(fd)
    }
  }

  /** `read`, its file-system errors said by `safe`. */
  #readUnsafe(path: string, range?: { from: number; lines: number }): FileRead {
    const r = this.#resolve(path)
    if (r.rest.length === 0 && r.area !== "story") {
      throw new FileRefusal("not-a-file", `${r.canonical} is a folder: list it`)
    }
    const ext = extension(r)
    const mime = IMAGES[ext]
    if (mime !== undefined) {
      const { bytes, hash } = this.#readAll(r, FILE_LIMITS.imageBytes)
      return { kind: "image", path: r.canonical, bytes, mime, hash }
    }
    const { bytes, hash } = this.#readAll(r, FILE_LIMITS.textReadBytes)
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      throw new FileRefusal("not-text", `${r.canonical} isn't text (UTF-8)`)
    }
    // A final newline ends the last line (no empty line after it); a read that reaches the end
    // gives it back.
    const all = text.split("\n")
    const ending = all.length > 1 && all.at(-1) === ""
    if (ending) all.pop()
    // The whole file unless a range is asked for; either way within the return cap, cut at a line
    // (never inside a character), and `partial` says so whenever any of it is left out.
    if (
      range !== undefined &&
      (!Number.isSafeInteger(range.from) ||
        !Number.isSafeInteger(range.lines) ||
        range.from < 1 ||
        range.lines < 1)
    ) {
      throw new FileRefusal("bad-path", "a line range is { from, lines }: whole numbers from 1")
    }
    const from = range === undefined ? 1 : range.from
    const count = range === undefined ? all.length : Math.min(FILE_LIMITS.rangeLines, range.lines)
    const lines = all.slice(from - 1, from - 1 + count)
    let returned = 0
    let kept = 0
    for (const line of lines) {
      const size = Buffer.byteLength(line) + 1
      if (kept > 0 && returned + size > FILE_LIMITS.textReturnBytes) break
      returned += size
      kept++
    }
    let chosen = lines.slice(0, kept).join("\n")
    let partial = from > 1 || from - 1 + kept < all.length
    if (ending && kept > 0 && from - 1 + kept === all.length) chosen += "\n"
    // A single line over the cap (a minified file): its start, whole characters only.
    if (Buffer.byteLength(chosen) > FILE_LIMITS.textReturnBytes) {
      let size = 0
      let end = 0
      for (const ch of chosen) {
        size += Buffer.byteLength(ch)
        if (size > FILE_LIMITS.textReturnBytes) break
        end += ch.length
      }
      chosen = chosen.slice(0, end)
      partial = true
    }
    return { kind: "text", path: r.canonical, text: chosen, hash, lines: all.length, partial }
  }

  /** `list`, its file-system errors said by `safe`. */
  #listUnsafe(path: string): { path: string; entries: FileEntry[]; truncated: boolean } {
    const r = this.#resolve(path)
    if (r.area === "story") throw new FileRefusal("not-a-file", "story.md is a file: read it")
    const abs = this.#absolute(r)
    try {
      this.#walk(r, "folder")
    } catch (error) {
      // An area not made yet (pages/ before the first page): empty.
      if (error instanceof FileRefusal && error.code === "not-found" && r.rest.length === 0) {
        return { path: r.canonical, entries: [], truncated: false }
      }
      throw error
    }
    const entries: FileEntry[] = []
    let truncated = false
    const dir = opendirSync(abs)
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        if (entry.name.startsWith(".")) continue
        if (entries.length >= FILE_LIMITS.listEntries) {
          truncated = true
          break
        }
        let stat: Stats
        try {
          stat = lstatSync(join(abs, entry.name))
        } catch {
          continue // gone meanwhile
        }
        if (stat.isFile()) entries.push({ name: entry.name, kind: "file", size: stat.size })
        else if (stat.isDirectory()) entries.push({ name: entry.name, kind: "folder", size: 0 })
      }
    } finally {
      dir.closeSync()
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return { path: r.canonical, entries, truncated }
  }

  // ── Writing ───────────────────────────────────────────────────────────────────────────────

  /** `write`, its file-system errors said by `safe`. */
  #writeUnsafe(
    path: string,
    text: string,
    { ifHash }: { ifHash: string | null },
  ): { path: string; hash: string } {
    const r = this.#resolve(path)
    this.#writable(r, "write")
    if (r.area === "story") {
      const chars = [...text].length
      if (chars > FILE_LIMITS.storyChars) {
        throw new FileRefusal(
          "too-large",
          `story.md is at most ${FILE_LIMITS.storyChars} characters (this is ${chars}): keep it short`,
        )
      }
    } else if (!TEXT_WRITE.has(extension(r))) {
      throw new FileRefusal(
        "not-allowed",
        `${r.canonical}: a page is written as text (.html, .css, .js, .json, .svg, .md, .txt); copy images and fonts in`,
      )
    }
    const bytes = Buffer.from(text, "utf8")
    if (r.area === "pages" && bytes.length > FILE_LIMITS.pageFileBytes) {
      throw new FileRefusal("too-large", `${r.canonical}: a page's file is at most 512 KB`)
    }
    return this.#put(r, bytes, ifHash)
  }

  /** `copy`, its file-system errors said by `safe`. */
  #copyUnsafe(
    from: string,
    to: string,
    { ifHash }: { ifHash: string | null },
  ): { path: string; hash: string } {
    const source = this.#resolve(from)
    const target = this.#resolve(to)
    if (source.area === "story") throw new FileRefusal("not-allowed", "story.md isn't copied")
    if (target.area !== "pages") {
      throw new FileRefusal("read-only", `${target.canonical}: files are copied into pages/ only`)
    }
    this.#writable(target, "copy into")
    if (!COPY_TO.has(extension(target))) {
      throw new FileRefusal(
        "not-allowed",
        `${target.canonical}: only a page's own types are copied in (text, images, fonts)`,
      )
    }
    // A text file copied keeps a page file's limit (images and fonts up to an image's).
    const cap = TEXT_WRITE.has(extension(target))
      ? FILE_LIMITS.pageFileBytes
      : FILE_LIMITS.imageBytes
    const { bytes } = this.#readAll(source, cap, true)
    return this.#put(target, Buffer.from(bytes), ifHash)
  }

  /** `delete`, its file-system errors said by `safe`. */
  #deleteUnsafe(path: string, { ifHash }: { ifHash: string }): { path: string } {
    const r = this.#resolve(path)
    if (r.area !== "pages" || r.rest.length === 0) {
      throw new FileRefusal("read-only", `${r.canonical}: only a file in pages/ is deleted`)
    }
    const { hash } = this.#readCurrent(r)
    if (hash === undefined) throw new FileRefusal("not-found", `${r.canonical} doesn't exist`)
    if (hash !== ifHash) throw changed(r)
    try {
      unlinkSync(this.#absolute(r))
    } catch (error) {
      throw this.#io(error, r, "delete")
    }
    // Folders it leaves empty, up to (never) pages/ itself; the last folder changed synced.
    let n = r.rest.length - 1
    for (; n >= 1; n--) {
      try {
        rmdirSync(join(this.#root, "pages", ...r.rest.slice(0, n)))
      } catch {
        break // not empty (or gone): stop
      }
    }
    syncFolder(join(this.#root, "pages", ...r.rest.slice(0, n)))
    return { path: r.canonical }
  }

  /** The areas the agent writes in: story.md and pages/ (a file, never an area itself). */
  #writable(r: Resolved, what: string): void {
    if (r.area === "inputs" || r.area === "templates") {
      throw new FileRefusal(
        "read-only",
        `${r.canonical}: ${r.area === "inputs" ? "the user's attachments" : "Kiframe's templates"} are read only (copy into pages/)`,
      )
    }
    if (r.area === "pages" && r.rest.length === 0) {
      throw new FileRefusal("not-a-file", `can't ${what} pages/ itself: name a file in it`)
    }
  }

  /** The current hash of a file (undefined: it doesn't exist), read through a descriptor. */
  #readCurrent(r: Resolved): { hash: string | undefined } {
    if (this.#walk(r, "absent-ok") === undefined) return { hash: undefined }
    const fd = this.#open(this.#absolute(r), r, constants.O_RDONLY)
    try {
      // Never read (read refuses it), so never hashed either: no way to test a guess at it.
      if (fstatSync(fd).nlink > 1) {
        throw new FileRefusal(
          "link",
          `${r.canonical}: a file with several hard links is never read or replaced`,
        )
      }
      const hash = createHash("sha256")
      const chunk = Buffer.alloc(64 * 1024)
      let total = 0
      for (
        let n = readSync(fd, chunk, 0, chunk.length, null);
        n > 0;
        n = readSync(fd, chunk, 0, chunk.length, null)
      ) {
        total += n
        if (total > FILE_LIMITS.imageBytes)
          throw new FileRefusal("too-large", `${r.canonical} is too large`)
        hash.update(chunk.subarray(0, n))
      }
      return { hash: hash.digest("hex") }
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Puts bytes at a checked path. Checked before anything is made (no link on the way, the room
   * left); its folders made one level at a time (each a real folder, never one named like another
   * but for case or accents), removed again if the write is refused; a temporary sibling written
   * exclusively, then linked into place when the file must not exist (the kernel refuses an
   * existing name: no race) or renamed over the one whose hash was read.
   */
  #put(r: Resolved, bytes: Buffer, ifHash: string | null): { path: string; hash: string } {
    this.#walk(r, "absent-ok")
    if (r.area === "pages") this.#checkPagesRoom(r, bytes.length)
    const made: string[] = []
    try {
      const folder = this.#ensureFolders(r, made)
      const name = r.area === "story" ? "story.md" : (r.rest.at(-1) as string)
      const target = join(folder, name)
      // A new file: never a name the disk would take for another's.
      if (ifHash === null) this.#checkNew(r, folder, name)
      const tmp = join(folder, tempName())
      const fd = this.#open(
        tmp,
        { ...r, canonical: `${r.canonical} (temporary)` },
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o644,
      )
      try {
        try {
          for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        if (ifHash === null) {
          try {
            linkSync(tmp, target)
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code === "EEXIST") {
              throw new FileRefusal(
                "exists",
                `${r.canonical} already exists: read it, then write it with its hash`,
              )
            }
            // A disk without hard links (exFAT, FAT, some shares): the name taken exclusively
            // (an existing one refused by the kernel), then our full file renamed over it.
            if (
              code !== "ENOTSUP" &&
              code !== "EPERM" &&
              code !== "EOPNOTSUPP" &&
              code !== "EXDEV"
            ) {
              throw error
            }
            closeSync(
              this.#open(
                target,
                r,
                constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
                0o644,
              ),
            )
            try {
              renameSync(tmp, target)
            } catch (error) {
              rmSync(target, { force: true }) // the empty name we just took, never left empty
              throw error
            }
          }
        } else {
          const { hash } = this.#readCurrent(r)
          if (hash === undefined) {
            throw new FileRefusal(
              "not-found",
              `${r.canonical} doesn't exist any more: write it as a new file`,
            )
          }
          if (hash !== ifHash) throw changed(r)
          // (APFS keeps the existing entry's name: `Logo.svg` replaced as `LOGO.svg` stays `Logo.svg`.)
          renameSync(tmp, target)
        }
      } finally {
        rmSync(tmp, { force: true })
      }
      syncFolder(folder)
      // Each folder made, its entry in its parent too (a crash never loses a written page's folder).
      for (const dir of made) syncFolder(join(dir, ".."))
      return { path: r.canonical, hash: hashOf(bytes) }
    } catch (error) {
      // A refused write leaves no folder it made.
      for (const dir of made.reverse()) {
        try {
          rmdirSync(dir)
        } catch {
          break
        }
      }
      throw error
    }
  }

  /**
   * The target's folder, made inside pages/ one level at a time; an existing one a real folder on
   * the project's disk, named as asked (not another one's name but for case or accents).
   */
  #ensureFolders(r: Resolved, made: string[]): string {
    if (r.area === "story") return this.#root
    let at = this.#root
    for (const part of ["pages", ...r.rest.slice(0, -1)]) {
      const parent = at
      at = join(at, part)
      let created = false
      try {
        mkdirSync(at)
        created = true
        made.push(at)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      const stat = lstatSync(at)
      if (stat.isSymbolicLink()) {
        throw new FileRefusal("link", `${r.canonical}: links are never followed`)
      }
      if (!stat.isDirectory()) {
        throw new FileRefusal("not-a-file", `${r.canonical}: ${part} isn't a folder`)
      }
      if (stat.dev !== this.#dev) {
        throw new FileRefusal("not-allowed", `${r.canonical}: on another disk`)
      }
      if (!created && at !== join(this.#root, "pages") && !hasName(parent, part)) {
        throw new FileRefusal(
          "collision",
          `${r.canonical}: the folder is named ${diskName(parent, part)} (not ${part}): use that name`,
        )
      }
    }
    return at
  }

  /**
   * A new file's name: free, or taken (exists), or one the disk would take for another file's (a
   * case- or normalization-insensitive disk: `Logo.png` for `logo.png`), asked of the disk.
   */
  #checkNew(r: Resolved, folder: string, name: string): void {
    let stat: Stats
    try {
      stat = lstatSync(join(folder, name))
    } catch {
      return // nothing there
    }
    if (stat.isSymbolicLink()) {
      throw new FileRefusal("link", `${r.canonical}: links are never followed`)
    }
    if (!hasName(folder, name)) {
      throw new FileRefusal(
        "collision",
        `${r.canonical}: a file is named ${diskName(folder, name)}, which this disk takes for ${name}: use that name`,
      )
    }
    throw new FileRefusal(
      "exists",
      `${r.canonical} already exists: read it, then write it with its hash`,
    )
  }

  /** pages/ stays within its limits after this write: all of it, its page folder, its file count. */
  #checkPagesRoom(r: Resolved, adding: number): void {
    const current = this.#currentSize(r)
    const pages = sizeOf(join(this.#root, "pages"))
    const files = pages.files + (current === undefined ? 1 : 0)
    const bytes = pages.bytes - (current ?? 0) + adding
    if (bytes > FILE_LIMITS.pagesBytes || files > FILE_LIMITS.pagesFiles) {
      throw new FileRefusal(
        "too-large",
        "pages/ is full (100 MB, 2,000 files): delete what isn't used",
      )
    }
    const page = r.rest.length >= 2 ? (r.rest[0] as string) : undefined
    if (page !== undefined) {
      const inPage = (pages.byPage.get(page.normalize("NFC")) ?? 0) - (current ?? 0) + adding
      if (inPage > FILE_LIMITS.pageFolderBytes) {
        throw new FileRefusal("too-large", `pages/${page}/ is at most 20 MB`)
      }
    }
  }

  /** The size of the file a write replaces (undefined: none). */
  #currentSize(r: Resolved): number | undefined {
    try {
      const stat = lstatSync(this.#absolute(r))
      return stat.isFile() ? stat.size : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * pages/'s total size, file count and size per page folder, in one walk within limits (deeper or
 * wider: refused); never through a link (each entry lstat-ed, pages/ itself a real folder).
 */
function sizeOf(pages: string): { bytes: number; files: number; byPage: Map<string, number> } {
  const byPage = new Map<string, number>()
  let bytes = 0
  let files = 0
  let seen = 0
  try {
    const root = lstatSync(pages)
    if (!root.isDirectory())
      throw new FileRefusal("link", "pages/ isn't a folder: links are never followed")
  } catch (error) {
    if (error instanceof FileRefusal) throw error
    return { bytes, files, byPage } // not made yet
  }
  const walk = (dir: string, depth: number, page: string | undefined) => {
    if (depth > FILE_LIMITS.walkDepth)
      throw new FileRefusal("too-large", "pages/ is nested too deep")
    const handle = opendirSync(dir)
    try {
      for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
        // Hidden entries aren't the agent's (it can't see or delete them): not counted.
        if (entry.name.startsWith(".")) continue
        if (++seen > FILE_LIMITS.walkEntries) {
          throw new FileRefusal("too-large", "pages/ has too many entries")
        }
        const at = join(dir, entry.name)
        let stat: Stats
        try {
          stat = lstatSync(at)
        } catch {
          continue // gone meanwhile (an editor's temporary file)
        }
        const inPage = page ?? entry.name.normalize("NFC")
        if (stat.isFile()) {
          bytes += stat.size
          files++
          if (page !== undefined) byPage.set(page, (byPage.get(page) ?? 0) + stat.size)
        } else if (stat.isDirectory()) walk(at, depth + 1, inPage)
      }
    } finally {
      handle.closeSync()
    }
  }
  walk(pages, 0, undefined)
  return { bytes, files, byPage }
}

/** Whether a folder has an entry named exactly `name` (Unicode forms aside), asked of the disk. */
function hasName(folder: string, name: string): boolean {
  const want = name.normalize("NFC")
  return readdirSync(folder).some((entry) => entry.normalize("NFC") === want)
}

/** The spelling on disk of the entry a case- or form-insensitive disk takes `name` for. */
function diskName(folder: string, name: string): string {
  const want = name.normalize("NFC").toLowerCase()
  return readdirSync(folder).find((e) => e.normalize("NFC").toLowerCase() === want) ?? name
}

function extension(r: Resolved): string {
  const name = r.area === "story" ? "story.md" : (r.rest.at(-1) ?? "")
  const dot = name.lastIndexOf(".")
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase()
}

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function changed(r: Resolved): FileRefusal {
  return new FileRefusal("changed", `${r.canonical} changed since you read it: read it again`)
}

/** A call whose file-system errors are said by their code and the path asked (never absolute). */
function safe<T>(what: string, path: string, call: () => T): T {
  try {
    return call()
  } catch (error) {
    if (error instanceof FileRefusal) throw error
    const code = (error as NodeJS.ErrnoException).code ?? "an error"
    throw new FileRefusal(
      "io",
      `couldn't ${what} ${JSON.stringify(String(path)).slice(0, 200)} (${code})`,
    )
  }
}
