import { describe, expect, it } from "vitest"
import { sceneIdOf } from "../scripts/lib/scenes.ts"

describe("sceneIdOf", () => {
  it("makes a kebab-case id from the folder and the name, never empty", () => {
    expect(sceneIdOf("examples/calcom/grounded-dsflash.yaml")).toBe("calcom-grounded-dsflash")
    expect(sceneIdOf("examples/dim0/grounded-dsflash.yaml")).toBe("dim0-grounded-dsflash")
    expect(sceneIdOf("_login.yaml")).toBe("login")
    expect(sceneIdOf(".yaml")).toBe("scene")
  })
})
