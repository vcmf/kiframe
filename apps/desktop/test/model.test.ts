import { describe, expect, it } from "vitest"
import { modelConfig } from "../src/main/model.ts"

describe("the agent's model", () => {
  it("is served by OpenRouter's fastest provider (the default route took minutes a turn)", () => {
    expect(modelConfig("k")).toEqual({
      apiKey: "k",
      model: "deepseek/deepseek-v4.1-flash",
      fastestProvider: true,
    })
  })
})
