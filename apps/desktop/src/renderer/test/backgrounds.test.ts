import shipped from "@kiframe/compositor/backgrounds/backgrounds.json"
import { describe, expect, it } from "vitest"
import { BACKGROUND_URLS } from "../src/backgrounds.ts"

describe("the preview's backgrounds", () => {
  it("bundles the file the compositor ships for each background (the exporter's list)", () => {
    const list = shipped.backgrounds
    expect(Object.keys(BACKGROUND_URLS).sort()).toEqual(list.map((b) => b.id).sort())
    for (const b of list) {
      expect(BACKGROUND_URLS[b.id as keyof typeof BACKGROUND_URLS]).toMatch(
        new RegExp(`/${b.file.replace(".", "\\.")}$`),
      )
    }
  })
})
