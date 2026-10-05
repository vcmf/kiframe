import { describe, expect, it } from "vitest"
import { applyStyle, DEFAULT_STYLE, StyleOverride } from "./style.ts"

describe("a scene's background", () => {
  it("is one of Kiframe's images by default, overridden by the project or the scene", () => {
    expect(DEFAULT_STYLE.background).toEqual({ builtin: "mountain-lake" })
    const project = StyleOverride.parse({ background: { builtin: "forest-lake" } })
    const scene = StyleOverride.parse({ background: "none" })
    expect(applyStyle(DEFAULT_STYLE, project).background).toEqual({ builtin: "forest-lake" })
    expect(applyStyle(DEFAULT_STYLE, project, scene).background).toBe("none")
  })

  it("refuses an image Kiframe doesn't ship, and reads a former gradient as unset", () => {
    expect(StyleOverride.safeParse({ background: { builtin: "beach" } }).success).toBe(false)
    expect(StyleOverride.safeParse({ background: { file: "x.jpg" } }).success).toBe(false)
    const old = StyleOverride.parse({ background: ["#000000", "#111111"], radius: 4 })
    expect(old).toEqual({ radius: 4 })
    expect(applyStyle(DEFAULT_STYLE, old).background).toEqual({ builtin: "mountain-lake" })
    // Only the former two colors: any other array is the typo it looks like.
    for (const bad of [[], ["none"], [{ builtin: "forest-lake" }], ["#000000"]]) {
      expect(StyleOverride.safeParse({ background: bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })
})
