import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SceneId } from "@kiframe/schema"
import { describe, expect, it } from "vitest"
import { Registry } from "../src/main/registry.ts"

const dirs = () => {
  const data = mkdtempSync(join(tmpdir(), "kiframe-registry-"))
  const a = join(data, "a.kiframe")
  const b = join(data, "b.kiframe")
  mkdirSync(a)
  mkdirSync(b)
  return { data, a, b }
}

describe("the host's ids", () => {
  it("gives each folder its own scope, stable across launches and through a symlink", () => {
    const { data, a, b } = dirs()
    const first = new Registry(data)
    const scope = first.scope(a)
    expect(scope).toMatch(/^folder-[0-9a-f]{16}$/)
    expect(first.scope(b)).not.toBe(scope)
    expect(new Registry(data).scope(a)).toBe(scope)
    const link = join(data, "link.kiframe")
    symlinkSync(a, link)
    expect(new Registry(data).scope(link)).toBe(scope)
  })

  it("keys each scene, stably, kebab-case; a removed scene's id gets a new key", () => {
    const { data, a, b } = dirs()
    const registry = new Registry(data)
    const key = registry.sceneKey(a, "tour")
    expect(SceneId.safeParse(key).success).toBe(true)
    expect(new Registry(data).sceneKey(a, "tour")).toBe(key)
    expect(registry.sceneKey(b, "tour")).not.toBe(key)
    registry.forgetScene(a, "tour")
    expect(new Registry(data).sceneKey(a, "tour")).not.toBe(key)
  })

  it("never replaces a registry that doesn't read (approvals hang on it)", () => {
    const { data } = dirs()
    writeFileSync(join(data, "registry.json"), "{ not json")
    expect(() => new Registry(data)).toThrow()
  })
})
