import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

// The macOS self-test can't run (no link can be made in the temp folder).
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>()
  return {
    ...fs,
    symlinkSync: () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    },
  }
})

const { FileRefusal, ProjectFiles } = await import("../src/project-files.ts")

describe("without the kernel's no-link flag checked", () => {
  it.runIf(process.platform === "darwin")("opens the project and refuses each file call", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kiframe-noflag-")), "demo.kiframe")
    mkdirSync(dir)
    const files = new ProjectFiles(dir)
    for (let i = 0; i < 2; i++) {
      let refused: unknown
      try {
        files.write("pages/a.html", "<p>a</p>", { ifHash: null })
      } catch (error) {
        refused = error
      }
      expect(refused instanceof FileRefusal && refused.code).toBe("io")
    }
  })
})
