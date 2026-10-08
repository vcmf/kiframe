import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createProject, TakeStore } from "@kiframe/project"
import { parseProjectYaml } from "@kiframe/schema"
import { isWithImages, type WithImages } from "@kiframe/agent"
import { chromium, type Browser } from "playwright"
import { PNG } from "pngjs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type FileNote, Studio, studioTools, type UserRequest } from "../src/index.ts"

// C2 (OBJECT-MODEL §0.13): the agent's file tools over the project's files it may see.

const never = new AbortController().signal
const tool = (name: string) => {
  const found = studioTools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return found
}

/** A studio over a fresh project (no browser: the file tools never use one). */
function studioWith(
  options: {
    files?: Record<string, string>
    answers?: boolean[]
    secrets?: string[]
    fileReads?: Map<string, FileNote>
    browser?: Browser
    seesImages?: boolean
  } = {},
) {
  const dir = join(mkdtempSync(join(tmpdir(), "kiframe-files-tools-")), "demo.kiframe")
  const project = createProject(dir, { id: "p1", name: "Demo", url: "https://app.test" })
  for (const [path, content] of Object.entries(options.files ?? {})) {
    mkdirSync(join(dir, path, ".."), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const asked: UserRequest[] = []
  const kept: [string, string][] = []
  const stopped: string[] = []
  const answers = [...(options.answers ?? [])]
  const studio = new Studio({
    project,
    scope: "folder-1",
    sceneKey: (id) => `host-${id}`,
    config: parseProjectYaml(`version: 2\napps: { app: { kind: web, url: "https://app.test" } }\n`),
    takes: new TakeStore(mkdtempSync(join(tmpdir(), "kiframe-files-data-"))),
    browser: options.browser ?? ({} as Browser),
    ...(options.seesImages !== undefined && {
      seesImages: () => Promise.resolve(options.seesImages ?? true),
    }),
    requestUser: (request) => {
      asked.push(request)
      return Promise.resolve(answers.shift() ?? false)
    },
    knownValues: () => new Set(options.secrets ?? []),
    keepVersion: (path, bytes) => kept.push([path, Buffer.from(bytes).toString("utf8")]),
    stopRun: (why) => stopped.push(why),
    ...(options.fileReads !== undefined && { fileReads: options.fileReads }),
  })
  const run = (name: string, args: object) => tool(name).run(args, studio, never)
  return { dir, studio, run, asked, kept, stopped }
}

const HASH = /[0-9a-f]{64}/
/** Bytes that aren't UTF-8 (a font's, say). */
const FONT = Buffer.from([0x77, 0x4f, 0x46, 0xff, 0xfe, 0x00])

describe("the file tools", () => {
  it("lists, reads, creates, edits, copies and deletes, never giving a hash or bytes", async () => {
    const { dir, run, asked } = studioWith({
      files: { "inputs/logo.png": "\u0089PNG fake", "pages/a.html": "<p>hello</p>" },
      answers: [true],
    })
    expect(await run("list_files", { path: "pages" })).toBe("pages: a.html (12 bytes)")
    expect(await run("list_files", { path: "." })).toMatch(/^\.: story\.md, pages\/, inputs\//)
    const read = (await run("read_file", { path: "pages/a.html" })) as string
    expect(read).toBe("pages/a.html (1 lines)\n<p>hello</p>")
    expect(await run("write_file", { path: "pages/b.html", content: "<p>b</p>" })).toBe(
      "Created pages/b.html",
    )
    expect(await run("edit_file", { path: "pages/a.html", old: "hello", new: "hi" })).toBe(
      "Edited pages/a.html (at line 1)",
    )
    expect(readFileSync(join(dir, "pages", "a.html"), "utf8")).toBe("<p>hi</p>")
    // Not a real PNG: never shown (its header says no image), its hash noted all the same.
    const image = JSON.stringify(await run("read_file", { path: "inputs/logo.png" }))
    expect(image).toMatch(/inputs\/logo\.png: it can't be decoded as an image/)
    expect(await run("copy_file", { from: "inputs/logo.png", to: "pages/logo.png" })).toBe(
      "Copied inputs/logo.png to pages/logo.png",
    )
    await run("read_file", { path: "pages/b.html" })
    expect(await run("delete_file", { path: "pages/b.html" })).toBe("Deleted pages/b.html")
    expect(asked).toEqual([{ kind: "approve-file", action: "delete", path: "pages/b.html" }])
    for (const said of [read, image]) expect(said).not.toMatch(HASH)
  })

  it("never writes over a file the agent didn't read, read only in part, or changed since", async () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const { dir, run } = studioWith({ files: { "pages/a.html": long, "pages/b.html": "<p>b</p>" } })
    expect(await run("write_file", { path: "pages/a.html", content: "x" })).toEqual({
      error: "pages/a.html exists: read it first",
    })
    await run("read_file", { path: "pages/a.html", from: 1, lines: 5 })
    expect(await run("write_file", { path: "pages/a.html", content: "x" })).toMatchObject({
      error: expect.stringMatching(/didn't see all of it/) as unknown,
    })
    await run("read_file", { path: "pages/b.html" })
    writeFileSync(join(dir, "pages", "b.html"), "<p>the user's</p>")
    expect(await run("write_file", { path: "pages/b.html", content: "x" })).toEqual({
      error: "pages/b.html changed since you read it: read it again",
    })
    expect(
      await run("edit_file", { path: "pages/b.html", old: "the user's", new: "x" }),
    ).toMatchObject({ error: expect.stringMatching(/changed since you read it/) as unknown })
    expect(readFileSync(join(dir, "pages", "b.html"), "utf8")).toBe("<p>the user's</p>")
  })

  it("asks the user before replacing whole a file the agent didn't write (an edit asks no one)", async () => {
    const { dir, run, asked, kept } = studioWith({
      files: { "pages/a.html": "<p>user</p>" },
      answers: [false, true],
    })
    await run("read_file", { path: "pages/a.html" })
    expect(
      await run("write_file", { path: "pages/a.html", content: "<p>agent</p>" }),
    ).toMatchObject({
      error: expect.stringMatching(/kept pages\/a\.html/) as unknown,
    })
    expect(await run("write_file", { path: "pages/a.html", content: "<p>agent</p>" })).toBe(
      "Wrote pages/a.html",
    )
    expect(asked.map((r) => r.kind)).toEqual(["approve-file", "approve-file"])
    // Its own file now: replaced again without asking; edited without asking.
    expect(await run("write_file", { path: "pages/a.html", content: "<p>again</p>" })).toBe(
      "Wrote pages/a.html",
    )
    expect(await run("edit_file", { path: "pages/a.html", old: "again", new: "once" })).toMatch(
      /^Edited/,
    )
    expect(asked).toHaveLength(2)
    expect(readFileSync(join(dir, "pages", "a.html"), "utf8")).toBe("<p>once</p>")
    // Every version replaced was kept first.
    expect(kept.map(([, v]) => v)).toEqual(["<p>user</p>", "<p>agent</p>", "<p>again</p>"])
  })

  it("keeps a file the user declines to delete", async () => {
    const { dir, run } = studioWith({ files: { "pages/a.html": "<p>a</p>" }, answers: [false] })
    await run("read_file", { path: "pages/a.html" })
    expect(await run("delete_file", { path: "pages/a.html" })).toEqual({
      error: "the user kept pages/a.html",
    })
    expect(readFileSync(join(dir, "pages", "a.html"), "utf8")).toBe("<p>a</p>")
  })

  it("ends the run when the agent writes a secret's value (written, built up by edits, any length)", async () => {
    const { dir, run, stopped } = studioWith({
      files: { "pages/a.html": "<p>hello</p>" },
      secrets: ["hunter2-secret", "4821"],
    })
    expect(
      await run("write_file", { path: "pages/b.html", content: "aHVudGVyMi1zZWNyZXQ=" }),
    ).toMatchObject({ error: expect.stringMatching(/holds a secret's value/) as unknown })
    await run("read_file", { path: "pages/a.html" })
    await run("edit_file", { path: "pages/a.html", old: "hello", new: "hunter2" })
    expect(
      await run("edit_file", { path: "pages/a.html", old: "hunter2", new: "hunter2-secret" }),
    ).toMatchObject({ error: expect.stringMatching(/holds a secret's value/) as unknown })
    // Two pieces, each innocent, the value once together.
    expect(
      await run("edit_file", { path: "pages/a.html", old: "hunter2", new: "hunter2-sec" }),
    ).toMatch(/^Edited/)
    expect(
      await run("edit_file", { path: "pages/a.html", old: "-sec", new: "-secret" }),
    ).toMatchObject({ error: expect.stringMatching(/holds a secret's value/) as unknown })
    // A short value (a PIN) too: what a read would hide is never written.
    expect(
      await run("write_file", { path: "pages/pin.html", content: "<p>4821</p>" }),
    ).toMatchObject({ error: expect.stringMatching(/holds a secret's value/) as unknown })
    expect(readFileSync(join(dir, "pages", "a.html"), "utf8")).toBe("<p>hunter2-sec</p>")
    expect(existsSync(join(dir, "pages", "pin.html"))).toBe(false)
    expect(stopped).toHaveLength(4)
    expect(stopped.join(" ")).not.toMatch(/hunter2-secret|4821/)
  })

  it("never confirms a guess echoed back (a path), and never copies the user's file holding a value", async () => {
    const { run, stopped } = studioWith({
      files: { "inputs/notes.txt": "pw: Summer2024!" },
      secrets: ["Summer2024!"],
    })
    // Without the check, "pages/[secret] doesn't exist" would confirm it.
    expect(await run("read_file", { path: "pages/Summer2024!" })).toMatchObject({
      error: expect.stringMatching(/holds a secret's value/) as unknown,
    })
    expect(stopped).toHaveLength(1)
    // Not the agent's guess (the user's attachment): refused, the run goes on.
    expect(
      await run("copy_file", { from: "inputs/notes.txt", to: "pages/notes.png" }),
    ).toMatchObject({
      error: expect.stringMatching(/inputs\/notes\.txt holds a secret's value/) as unknown,
    })
    expect(stopped).toHaveLength(1)
  })

  it("never lets a read with a secret scrubbed out be written back whole, nor the file be edited (no guessing at it)", async () => {
    const { dir, run, stopped } = studioWith({
      files: { "pages/a.html": "<p>user: bob@acme.com</p><p>more</p>" },
      secrets: ["bob@acme.com"],
      answers: [true],
    })
    const read = (await run("read_file", { path: "pages/a.html" })) as string
    expect(read).toContain("[secret]")
    expect(await run("write_file", { path: "pages/a.html", content: read })).toMatchObject({
      error: expect.stringMatching(/didn't see all of it/) as unknown,
    })
    // A guess at the value (in the file or not) and a plain edit: one answer, nothing changed.
    const answers = new Set<string>()
    for (const old of ["user: b", "user: z", "user: [secret]", "more"]) {
      const said = (await run("edit_file", { path: "pages/a.html", old, new: old })) as {
        error: string
      }
      answers.add(said.error)
    }
    expect([...answers]).toEqual([
      "pages/a.html holds a secret's value: it's never edited by you (the user changes it)",
    ])
    expect(readFileSync(join(dir, "pages", "a.html"), "utf8")).toBe(
      "<p>user: bob@acme.com</p><p>more</p>",
    )
    expect(stopped).toEqual([])
  })

  it("replaces a file seen whole in one read (parts never add up), or one it made", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")
    const { run } = studioWith({ files: { "pages/a.txt": long }, answers: [true] })
    for (const from of [1, 11, 21]) await run("read_file", { path: "pages/a.txt", from, lines: 10 })
    expect(await run("write_file", { path: "pages/a.txt", content: "x" })).toMatchObject({
      error: expect.stringMatching(/didn't see all of it/) as unknown,
    })
    await run("read_file", { path: "pages/a.txt" })
    // A part read again never takes the whole read away.
    await run("read_file", { path: "pages/a.txt", from: 2, lines: 1 })
    expect(await run("write_file", { path: "pages/a.txt", content: "x\ny" })).toBe(
      "Wrote pages/a.txt",
    )
    // Its own file: replaced again though it only read a part of it since.
    await run("read_file", { path: "pages/a.txt", from: 2, lines: 1 })
    expect(await run("write_file", { path: "pages/a.txt", content: "z" })).toBe("Wrote pages/a.txt")
  })

  it("copies to a path whose file the user deleted since it was read", async () => {
    const { dir, run } = studioWith({
      files: { "pages/logo.svg": "<svg/>", "inputs/logo.svg": "<svg>2</svg>" },
    })
    await run("read_file", { path: "pages/logo.svg" })
    rmSync(join(dir, "pages", "logo.svg"))
    expect(await run("copy_file", { from: "inputs/logo.svg", to: "pages/logo.svg" })).toBe(
      "Copied inputs/logo.svg to pages/logo.svg",
    )
  })

  it("deletes a file it can't read (a font), never replaces it unseen, and asks only for what can be done", async () => {
    const { dir, run, asked } = studioWith({ answers: [true] })
    for (const area of ["pages", "inputs"]) mkdirSync(join(dir, area), { recursive: true })
    writeFileSync(join(dir, "pages", "font.woff"), FONT)
    writeFileSync(join(dir, "inputs", "new.woff"), Buffer.from([...FONT, 1]))
    expect(await run("delete_file", { path: "pages/font.woff" })).toMatchObject({
      error: expect.stringMatching(/read pages\/font\.woff before/) as unknown,
    })
    expect(await run("read_file", { path: "pages/font.woff" })).toMatch(/can be deleted/)
    // Never seen: never replaced whole (not even with the user's say: never asked).
    expect(
      await run("copy_file", { from: "inputs/new.woff", to: "pages/font.woff" }),
    ).toMatchObject({ error: expect.stringMatching(/didn't see all of it/) as unknown })
    // Outside pages/, or changed since: refused before anyone is asked.
    await run("read_file", { path: "inputs/new.woff" })
    expect(
      await run("copy_file", { from: "pages/font.woff", to: "inputs/new.woff" }),
    ).toMatchObject({
      error: expect.stringMatching(/copied into pages\/ only/) as unknown,
    })
    writeFileSync(join(dir, "story.md"), "# story")
    await run("read_file", { path: "story.md" })
    expect(await run("delete_file", { path: "story.md" })).toMatchObject({
      error: expect.stringMatching(/only a file in pages/) as unknown,
    })
    writeFileSync(join(dir, "pages", "font.woff"), Buffer.from([...FONT, 2]))
    expect(await run("delete_file", { path: "pages/font.woff" })).toMatchObject({
      error: expect.stringMatching(/changed since/) as unknown,
    })
    expect(asked).toEqual([])
    // Read again, deleted (the user's say), copied anew.
    await run("read_file", { path: "pages/font.woff" })
    expect(await run("delete_file", { path: "pages/font.woff" })).toBe("Deleted pages/font.woff")
    expect(await run("copy_file", { from: "inputs/new.woff", to: "pages/font.woff" })).toMatch(
      /^Copied/,
    )
    // A file it copied in stays its own when read back: copied over without asking.
    await run("copy_file", { from: "inputs/new.woff", to: "pages/logo.png" })
    await run("read_file", { path: "pages/logo.png" })
    expect(await run("copy_file", { from: "inputs/new.woff", to: "pages/logo.png" })).toMatch(
      /^Copied/,
    )
    expect(asked).toHaveLength(1)
  })

  it("checks what the agent writes for values of 4 characters or more (a shorter one: ordinary text)", async () => {
    const { run, stopped } = studioWith({ secrets: ["ab1", "x9Q2"] })
    expect(await run("write_file", { path: "pages/a.html", content: "<p>tab1 ab1</p>" })).toBe(
      "Created pages/a.html",
    )
    expect(await run("write_file", { path: "pages/b.html", content: "x9q2" })).toMatchObject({
      error: expect.stringMatching(/holds a secret's value/) as unknown,
    })
    expect(stopped).toHaveLength(1)
  })

  it("never edits a file holding a short value either (what a read hides is never guessed at)", async () => {
    const { run } = studioWith({ files: { "pages/a.html": "<p>pin: 482</p>" }, secrets: ["482"] })
    expect(await run("read_file", { path: "pages/a.html" })).toContain("pin: [secret]")
    expect(
      await run("edit_file", { path: "pages/a.html", old: "pin: 4", new: "pin: 4" }),
    ).toMatchObject({ error: expect.stringMatching(/holds a secret's value/) as unknown })
  })

  it("answers a refusal, never throws, for a write over a file it can't read", async () => {
    const { dir, run } = studioWith({ files: { "pages/big.txt": "" } })
    writeFileSync(join(dir, "pages", "big.txt"), FONT)
    expect(await run("write_file", { path: "pages/big.txt", content: "x" })).toEqual({
      error: "pages/big.txt exists: read it first",
    })
  })

  it("never writes the user's attachments, nor outside the project's files", async () => {
    const { run } = studioWith({ files: { "inputs/a.txt": "a" } })
    expect(await run("write_file", { path: "inputs/a.txt", content: "b" })).toMatchObject({
      error: expect.stringMatching(/read only/) as unknown,
    })
    expect(await run("write_file", { path: "project.json", content: "{}" })).toMatchObject({
      error: expect.any(String) as unknown,
    })
    expect(await run("read_file", { path: "../secret.txt" })).toMatchObject({
      error: expect.any(String) as unknown,
    })
  })

  it("knows what the agent read across a studio remade (the host's notes)", async () => {
    const fileReads = new Map<string, FileNote>()
    const first = studioWith({ files: { "pages/a.html": "<p>a</p>" }, fileReads })
    await first.run("read_file", { path: "pages/a.html" })
    const again = new Studio({ ...first.studio.options, fileReads })
    expect(
      await tool("edit_file").run({ path: "pages/a.html", old: "a", new: "b" }, again, never),
    ).toMatch(/^Edited/)
  })
})

describe("an image read (E1: OBJECT-MODEL §0.12)", { timeout: 30_000 }, () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch()
  })
  afterAll(async () => {
    await browser.close()
  })
  const png = (width: number, height: number) => {
    const image = new PNG({ width, height })
    image.data.fill(255)
    return PNG.sync.write(image)
  }
  const withFiles = (files: Record<string, Buffer>, seesImages?: boolean) => {
    const made = studioWith({ browser, ...(seesImages !== undefined && { seesImages }) })
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(join(made.dir, path, ".."), { recursive: true })
      writeFileSync(join(made.dir, path), bytes)
    }
    return made
  }

  it("shows the agent an image: its pixels made again, its size said", async () => {
    const { run } = withFiles({ "inputs/logo.png": png(3000, 1000) })
    const read = await run("read_file", { path: "inputs/logo.png" })
    expect(isWithImages(read)).toBe(true)
    const { result, images } = read as WithImages
    expect(result).toBe(
      "inputs/logo.png: an image (PNG, 3000×1000 px, shown at 2000×667), shown below",
    )
    expect(images).toHaveLength(1)
    expect(images[0]?.url).toMatch(/^data:image\/png;base64,/)
    expect(JSON.stringify(read)).not.toMatch(HASH)
  })

  it("refuses an image when the model takes none, and look too: nothing sent", async () => {
    const { run, studio } = withFiles({ "inputs/logo.png": png(10, 10) }, false)
    const read = await run("read_file", { path: "inputs/logo.png" })
    expect(isWithImages(read)).toBe(false)
    expect(read).toEqual({
      error:
        "inputs/logo.png: the model doesn't take images: you can't see one; copy it into a page with copy_file",
    })
    expect(await tool("look").run({}, studio, never)).toEqual({
      error: "the model doesn't take images: you can't see one",
    })
    // The read is noted all the same: it can be copied over, deleted.
    expect(studio.fileReads.has("inputs/logo.png")).toBe(true)
  })

  it("never lets a refused image read count as seen whole (no replace of what wasn't seen)", async () => {
    const { run, asked } = withFiles({ "pages/notes.png": Buffer.from("not an image") })
    expect(await run("read_file", { path: "pages/notes.png" })).toMatchObject({
      error: expect.stringMatching(/can't be decoded/) as unknown,
    })
    await run("copy_file", { from: "pages/notes.png", to: "pages/other.png" })
    expect(await run("copy_file", { from: "pages/other.png", to: "pages/notes.png" })).toEqual({
      error: "pages/notes.png: you didn't see all of it: read it all at once first",
    })
    expect(asked).toEqual([])
  })

  it("says a browser that fails as a refusal, never a thrown error", async () => {
    const broken = {
      newContext: () => Promise.reject(new Error("Target crashed")),
    } as unknown as Browser
    const made = studioWith({ browser: broken })
    mkdirSync(join(made.dir, "inputs"), { recursive: true })
    writeFileSync(join(made.dir, "inputs/logo.png"), png(10, 10))
    expect(await made.run("read_file", { path: "inputs/logo.png" })).toEqual({
      error:
        "inputs/logo.png: it couldn't be decoded (the browser failed): try again; copy it into a page with copy_file",
    })
  })

  it("never shows text under an image's name (a page the agent wrote, copied in as .png)", async () => {
    const { run } = withFiles({ "inputs/notes.png": Buffer.from("<svg><text>hi</text></svg>") })
    const read = await run("read_file", { path: "inputs/notes.png" })
    expect(isWithImages(read)).toBe(false)
    expect(read).toEqual({
      error:
        "inputs/notes.png: it can't be decoded as an image (PNG, JPEG, GIF, WebP); copy it into a page with copy_file",
    })
  })
})

describe("the user's attachments stay the user's", () => {
  it("no agent tool writes or removes one (attach and unattach are the host's)", () => {
    for (const file of ["file-tools.ts", "tools.ts", "studio.ts", "run-notes.ts"]) {
      const source = readFileSync(join(import.meta.dirname, "../src", file), "utf8")
      expect(source, file).not.toMatch(/\.(un)?attach\(/)
    }
  })
})
