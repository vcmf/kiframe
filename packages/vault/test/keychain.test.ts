import { describe, expect, it } from "vitest"
import { keychainBackend } from "../src/index.ts"

// The real OS keychain: opt-in (it may prompt, and CI machines have none unlocked).
// KIFRAME_KEYCHAIN_TEST=1 pnpm vitest run packages/vault/test/keychain.test.ts
describe.runIf(process.env.KIFRAME_KEYCHAIN_TEST === "1")("keychainBackend", () => {
  it("stores, reads and deletes a value", async () => {
    const backend = keychainBackend("Kiframe-test")
    const name = `test.${process.pid}`
    await backend.set(name, "dummy-value")
    try {
      expect(await backend.get(name)).toBe("dummy-value")
    } finally {
      await backend.delete(name)
    }
    expect(await backend.get(name)).toBeUndefined()
  })
})
