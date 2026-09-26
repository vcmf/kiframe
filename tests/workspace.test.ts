import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Smoke test: every workspace package under packages/ has an entry point that loads.
const root = join(import.meta.dirname, "..", "packages")
const packages = readdirSync(root).map((dir) => {
  const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as {
    name: string
  }
  return manifest.name
})

describe("workspace packages", () => {
  it("finds the packages", () => {
    expect(packages.length).toBeGreaterThan(0)
  })

  it.each(packages)("%s loads", async (name) => {
    const mod: unknown = await import(name)
    expect(typeof mod).toBe("object")
  })
})
