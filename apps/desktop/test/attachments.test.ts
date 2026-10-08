import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FileRefusal, ProjectFiles } from "@kiframe/project"
import { PNG } from "pngjs"
import { describe, expect, it } from "vitest"
import { checkAttachments, storedMessage, writeAttachments } from "../src/main/attachments.ts"

const png = () => new Uint8Array(PNG.sync.write(new PNG({ width: 4, height: 4 })))
const text = (s: string) => new Uint8Array(new TextEncoder().encode(s))
const yes = () => Promise.resolve(true)

describe("the files the user attaches (E2)", () => {
  it("checks each file by its content, never only its name", async () => {
    expect(await checkAttachments([{ name: "Logo.png", bytes: png() }], yes)).toEqual([
      { name: "Logo.png", kind: "image", bytes: png() },
    ])
    expect(await checkAttachments([{ name: "brief.md", bytes: text("# Brief") }], yes)).toEqual([
      { name: "brief.md", kind: "text", bytes: text("# Brief") },
    ])
    const refused = async (name: string, bytes: Uint8Array<ArrayBuffer>) =>
      checkAttachments([{ name, bytes }], yes)
    expect(await refused("photo.jpg", png())).toBe("photo.jpg isn't the JPG image its name says")
    expect(await refused("logo.png", text("<html>"))).toBe(
      "logo.png isn't the PNG image its name says",
    )
    expect(await refused("run.sh", text("rm -rf ~"))).toMatch(/^run\.sh: attach images/)
    expect(await refused("notes.txt", new Uint8Array([0xff, 0xfe, 0x00]))).toBe(
      "notes.txt isn't text (UTF-8)",
    )
    expect(await refused("notes.txt", text("a\u0000b"))).toBe(
      "notes.txt isn't text (it holds NUL characters)",
    )
    expect(await refused("mock.html", new Uint8Array(512 * 1024 + 1))).toBe(
      "mock.html is over 0.5 MB",
    )
  })

  it("refuses an image for a model that takes none, and refuses all when one is refused", async () => {
    const no = () => Promise.resolve(false)
    expect(await checkAttachments([{ name: "logo.png", bytes: png() }], no)).toBe(
      "logo.png: the agent's model doesn't take images",
    )
    expect(
      await checkAttachments(
        [
          { name: "brief.md", bytes: text("ok") },
          { name: "bad.png", bytes: text("no") },
        ],
        yes,
      ),
    ).toBe("bad.png isn't the PNG image its name says")
  })

  it("writes every file or none (one failing removes those written before it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-attach-"))
    mkdirSync(join(dir, "inputs"))
    const real = new ProjectFiles(dir)
    let calls = 0
    const failing = {
      attach: (name: string, bytes: Uint8Array) => {
        if (++calls === 2) throw new FileRefusal("io", "couldn't attach b.md (ENOSPC)")
        return real.attach(name, bytes)
      },
      unattach: (path: string, hash: string) => real.unattach(path, hash),
    } as unknown as ProjectFiles
    const said = writeAttachments(failing, [
      { name: "a.md", kind: "text", bytes: text("a") },
      { name: "b.md", kind: "text", bytes: text("b") },
    ])
    expect(said).toBe("couldn't attach b.md (ENOSPC)")
    expect(readdirSync(join(dir, "inputs"))).toEqual([])
    const ok = writeAttachments(real, [{ name: "a.md", kind: "text", bytes: text("a") }])
    expect(ok).toMatchObject([{ path: "inputs/a.md", kind: "text" }])
    expect(existsSync(join(dir, "inputs/a.md"))).toBe(true)
  })

  it("keeps a line naming the files in the history", () => {
    const written = [
      { path: "inputs/logo.png", hash: "h", kind: "image" as const },
      { path: "inputs/brief.md", hash: "h", kind: "text" as const },
    ]
    expect(storedMessage("Use these", written)).toBe(
      "Use these\n\n[The user attached: inputs/logo.png (image), inputs/brief.md (text). They stay in inputs/: read_file to see them again.]",
    )
    expect(storedMessage("", written)).toMatch(/^\(files attached\)\n\n/)
    expect(storedMessage("Just text", [])).toBe("Just text")
  })
})
