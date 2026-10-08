import { defineTool } from "@kiframe/agent"
import { FileRefusal } from "@kiframe/project"
import { z } from "zod"
import type { Studio } from "./studio.ts"

// The agent's file tools (OBJECT-MODEL §0.13) over the project's files it may see: story.md,
// pages/ (written), inputs/ (read only). Never over what it hasn't seen: a whole replace needs the
// file unchanged since it read it (its hash, the host's) and either seen whole in one read, nothing
// scrubbed out, or made by it this session; an edit or a delete needs a read. Secrets: what it
// writes is checked at the tools' boundary (a value in it ends the run); an edit that builds one
// ends it too; a file holding one is never edited by it (found or not, an edit's answer would
// answer a guess at it). A hash or a file's bytes never reach the model.

/** A refusal as the model reads it (`FileRefusal`'s message: no absolute path, never a value). */
function refused(error: unknown): { error: string } {
  if (error instanceof FileRefusal) return { error: error.message }
  throw error
}

/**
 * What a read tells of a file (read_file's, and the run notes' story.md): its hash; seen whole (this
 * read, or an earlier one of these very bytes: parts never add up); made by the agent (these bytes).
 */
export function noteRead(studio: Studio, path: string, hash: string, seenWhole: boolean): void {
  const was = studio.fileReads.get(path)
  const same = was?.hash === hash
  studio.fileReads.set(path, {
    hash,
    full: seenWhole || (same && was.full),
    mine: same && was.mine,
  })
}

/** A file's canonical path, or the refusal of the path. */
function canonical(studio: Studio, path: string): string | { error: string } {
  try {
    return studio.files.canonical(path)
  } catch (error) {
    return refused(error)
  }
}

/** A file's hash now (undefined: there's none), or the refusal of reading it. */
function hashNow(studio: Studio, path: string): string | undefined | { error: string } {
  const now = statNow(studio, path)
  return now === undefined || "error" in now ? now : now.hash
}

/** A file's hash and whether it's blank now (undefined: there's none), or the refusal. */
function statNow(
  studio: Studio,
  path: string,
): { hash: string; blank: boolean } | undefined | { error: string } {
  try {
    return studio.files.stat(path)
  } catch (error) {
    if (error instanceof FileRefusal && error.code === "not-found") return undefined
    return refused(error)
  }
}

/** The user's say on replacing a file the agent didn't make (true: go on). */
async function replaceAllowed(studio: Studio, path: string, signal: AbortSignal) {
  return (
    (await studio.options.requestUser(
      { kind: "approve-file", action: "replace", path },
      signal,
    )) === true
  )
}

const path = z.string().min(1).max(1024)

const listFiles = defineTool({
  name: "list_files",
  description:
    "The files in one of the project's folders you may see: pages/, inputs/ (the user's attachments). story.md is at the project's root (read it by its name).",
  parameters: z.object({ path: path.describe("the folder: pages, pages/intro, inputs…") }),
  run: (args, studio: Studio) => {
    // The root holds only what the agent may see by name (never the scenes or the settings).
    if (["", ".", "./", "/"].includes(args.path.trim())) {
      return Promise.resolve(
        ".: story.md, pages/, inputs/ (list a folder by its name: pages, inputs)",
      )
    }
    try {
      const { path: at, entries, truncated } = studio.files.list(args.path)
      const lines = entries.map((e) =>
        e.kind === "folder" ? `${e.name}/` : `${e.name} (${e.size} bytes)`,
      )
      return Promise.resolve(
        `${at}: ${lines.length === 0 ? "empty" : lines.join(", ")}${truncated ? " (more not shown)" : ""}`,
      )
    } catch (error) {
      return Promise.resolve(refused(error))
    }
  },
})

const readFile = defineTool({
  name: "read_file",
  description:
    "A text file of the project (story.md, pages/…, inputs/…): its text (a long one by lines: from, lines). Read a file before you change it.",
  parameters: z.object({
    path,
    from: z.number().int().min(1).optional().describe("the first line (1-based)"),
    lines: z.number().int().min(1).max(2000).optional().describe("how many lines"),
  }),
  run: (args, studio: Studio) => {
    try {
      const range =
        args.from !== undefined || args.lines !== undefined
          ? { from: args.from ?? 1, lines: args.lines ?? 2000 }
          : undefined
      let read
      try {
        // Scrubbed whole before a part is cut (a value across lines, or across the cut).
        read = studio.files.read(args.path, range, studio.scrubber())
      } catch (error) {
        // A file it can't read as text (a font, a file in another encoding, one too large): noted
        // by its hash, for a delete only (never seen: never replaced whole). Never its bytes.
        if (
          error instanceof FileRefusal &&
          (error.code === "not-text" || error.code === "too-large")
        ) {
          const stat = studio.files.stat(args.path)
          noteRead(studio, stat.path, stat.hash, false)
          return Promise.resolve(
            `${error.message} (${stat.size} bytes): it can't be read, but it can be deleted (then copied anew)`,
          )
        }
        throw error
      }
      if (read.kind === "image") {
        // Its hash noted all the same (a copy over it, a delete); its bytes never sent.
        noteRead(studio, read.path, read.hash, true)
        return Promise.resolve(
          `${read.path}: an image (${read.mime}, ${read.bytes.length} bytes). You can't see images yet; copy it into a page with copy_file.`,
        )
      }
      noteRead(studio, read.path, read.hash, !read.partial && !read.scrubbed)
      const said = read.partial
        ? `${read.path} (lines ${range?.from ?? 1}… of ${read.lines}; part of it: read the rest by lines)`
        : `${read.path} (${read.lines} lines)`
      return Promise.resolve(`${said}\n${read.text}`)
    } catch (error) {
      return Promise.resolve(refused(error))
    }
  },
})

const writeFile = defineTool({
  name: "write_file",
  description:
    "Write a whole text file: story.md, or a page's file in pages/ (.html .css .js .json .svg .md .txt). A new file, or one you read whole (unchanged since) to replace it. For a small change, use edit_file.",
  parameters: z.object({ path, content: z.string().max(600_000) }),
  run: async (args, studio: Studio, signal) => {
    const files = studio.files
    // A new file first (a read-only area, a bad path: said as such); one that exists: replaced.
    try {
      const created = files.write(args.path, args.content, { ifHash: null })
      studio.fileReads.set(created.path, { hash: created.hash, full: true, mine: true })
      return `Created ${created.path}`
    } catch (error) {
      if (!(error instanceof FileRefusal) || error.code !== "exists") return refused(error)
    }
    const at = canonical(studio, args.path)
    if (typeof at !== "string") return at
    const now = statNow(studio, at)
    if (now === undefined || "error" in now) return now ?? { error: `${at} doesn't exist` }
    const note = studio.fileReads.get(at)
    if (note === undefined) return { error: `${at} exists: read it first` }
    if (note.hash !== now.hash) return { error: `${at} changed since you read it: read it again` }
    // A blank file (no bytes, a byte-order mark alone) loses nothing: written as a new one.
    const empty = now.blank
    if (!note.full && !note.mine && !empty) {
      return {
        error: `${at}: you didn't see all of it (a part, or a secret scrubbed out): change it with edit_file, or read it all at once`,
      }
    }
    // A file the user made (not the agent this session): replacing it whole is theirs to allow.
    if (!note.mine && !empty && !(await replaceAllowed(studio, at, signal))) {
      return { error: `the user kept ${at} as it is: edit it instead` }
    }
    try {
      const written = files.write(args.path, args.content, { ifHash: note.hash })
      studio.fileReads.set(written.path, { hash: written.hash, full: true, mine: true })
      return `Wrote ${written.path}`
    } catch (error) {
      return refused(error)
    }
  },
})

const editFile = defineTool({
  name: "edit_file",
  description:
    "Replace one exact passage of a text file you read (it must be in the file exactly once): a small change to a page or one section of story.md, the rest kept as it is.",
  parameters: z.object({
    path,
    old: z.string().min(1).max(100_000).describe("the passage as it is in the file (exactly once)"),
    new: z.string().max(100_000).describe("what replaces it"),
  }),
  run: (args, studio: Studio) => {
    const at = canonical(studio, args.path)
    if (typeof at !== "string") return Promise.resolve(at)
    const note = studio.fileReads.get(at)
    if (note === undefined) return Promise.resolve({ error: `read ${at} before you edit it` })
    try {
      const edited = studio.files.edit(args.path, args.old, args.new, {
        ifHash: note.hash,
        // A file holding a value: refused before the passage is looked for (one answer).
        guard: (before) => (studio.scrub(before) !== before ? "a secret's value" : undefined),
        // The file held none, nor did the passage: a value in the result is one put together.
        check: (result) => (studio.holdsSecret(result) ? "a secret's value" : undefined),
      })
      studio.fileReads.set(edited.path, { hash: edited.hash, full: note.full, mine: note.mine })
      return Promise.resolve(`Edited ${edited.path} (at line ${edited.line})`)
    } catch (error) {
      if (error instanceof FileRefusal && error.code === "guarded") {
        return Promise.resolve({
          error: `${at} holds a secret's value: it's never edited by you (the user changes it)`,
        })
      }
      if (error instanceof FileRefusal && error.code === "refused") {
        studio.options.stopRun(
          `Kif put a secret's value together in ${at}: refused, and the run stopped`,
        )
        return Promise.resolve({
          error: "refused: the result holds a secret's value (you never write one); the run stops",
        })
      }
      return Promise.resolve(refused(error))
    }
  },
})

const copyFile = defineTool({
  name: "copy_file",
  description:
    "Copy a file into pages/ (from inputs/ or pages/): how an image, a font or a stylesheet gets into a page (you never write binary). Over an existing file: only one you read.",
  parameters: z.object({ from: path, to: path }),
  run: async (args, studio: Studio, signal) => {
    const at = canonical(studio, args.to)
    if (typeof at !== "string") return at
    // What would refuse it anyway, before the user is asked.
    if (!at.startsWith("pages/")) return { error: `${at}: files are copied into pages/ only` }
    const target = studio.fileReads.get(at)
    const now = hashNow(studio, at)
    if (typeof now === "object") return now
    // Over a file: a whole replace (as write_file's): read, unchanged, known whole, the user's
    // allowed. A file noted but gone since: a new one.
    if (now !== undefined) {
      if (target === undefined) return { error: `${at} exists: read it first to copy over it` }
      if (now !== target.hash) return { error: `${at} changed since you read it: read it again` }
      if (!target.full && !target.mine) {
        return { error: `${at}: you didn't see all of it: read it all at once first` }
      }
      if (!target.mine && !(await replaceAllowed(studio, at, signal))) {
        return { error: `the user kept ${at} as it is` }
      }
    }
    try {
      const copied = studio.files.copy(args.from, args.to, {
        ifHash: now ?? null,
        // The user's file holding a value: never into a page (not the agent's guess: no stop).
        check: (text) =>
          studio.holdsSecret(text) ? `${args.from} holds a secret's value` : undefined,
      })
      // Bytes it made here (it knows where they came from), not text it saw.
      studio.fileReads.set(copied.path, { hash: copied.hash, full: false, mine: true })
      return `Copied ${args.from} to ${copied.path}`
    } catch (error) {
      if (error instanceof FileRefusal && error.code === "refused") {
        return { error: `${error.message}: it's never copied into a page` }
      }
      return refused(error)
    }
  },
})

const deleteFile = defineTool({
  name: "delete_file",
  description: "Delete a file in pages/ (one you read, unchanged since). The user approves it.",
  parameters: z.object({ path }),
  run: async (args, studio: Studio, signal) => {
    const at = canonical(studio, args.path)
    if (typeof at !== "string") return at
    // Everything that would refuse it, before the user is asked (never an approval for nothing).
    if (!at.startsWith("pages/")) return { error: `${at}: only a file in pages/ is deleted` }
    const note = studio.fileReads.get(at)
    if (note === undefined) return { error: `read ${at} before you delete it` }
    const now = hashNow(studio, at)
    if (typeof now === "object") return now
    if (now === undefined) return { error: `${at} doesn't exist` }
    if (now !== note.hash) return { error: `${at} changed since you read it: read it again` }
    const allowed =
      (await studio.options.requestUser(
        { kind: "approve-file", action: "delete", path: at },
        signal,
      )) === true
    if (!allowed) return { error: `the user kept ${at}` }
    try {
      const deleted = studio.files.delete(args.path, { ifHash: note.hash })
      studio.fileReads.delete(deleted.path)
      return `Deleted ${deleted.path}`
    } catch (error) {
      return refused(error)
    }
  },
})

export const fileTools = [listFiles, readFile, writeFile, editFile, copyFile, deleteFile]
