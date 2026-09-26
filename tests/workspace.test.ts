import { describe, expect, it } from "vitest"

// Smoke test: every workspace package entry point resolves and loads.
const packages = [
  "@kiframe/schema",
  "@kiframe/runtime",
  "@kiframe/generators",
  "@kiframe/compositor",
]

describe("workspace packages", () => {
  it.each(packages)("%s loads", async (name) => {
    await expect(import(name)).resolves.toBeDefined()
  })
})
