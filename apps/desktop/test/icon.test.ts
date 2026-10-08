import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { iconPng, iconSvg } from "../scripts/make-icon.ts"

const resources = join(import.meta.dirname, "../resources")

describe("the app icon", () => {
  // Drawn from Kif's pixel map, which the chat's mark shares: a change to one redraws the other.
  it("is the files drawn from Kif's pixel map (run scripts/make-icon.ts after changing it)", () => {
    expect(readFileSync(join(resources, "icon.svg"), "utf8")).toBe(iconSvg())
    expect(readFileSync(join(resources, "icon.png")).equals(iconPng())).toBe(true)
  })
})
