import { afterEach, describe, expect, it } from "vitest"
import { envSecretResolver } from "../scripts/lib/secrets.ts"

// The scripts' `.env` resolver: its secrets are for one app, never typed on a project's others
// (the runtime's own check only keeps a secret on the project's apps: which one is the resolver's).
describe("the scripts' secret resolver", () => {
  afterEach(() => {
    delete process.env.ACME_PASSWORD
  })

  it("gives a secret on its app's origin only", () => {
    process.env.ACME_PASSWORD = "hunter2-secret"
    const resolve = envSecretResolver(["acme.password"], "https://app.acme.test/login")
    expect(resolve("acme.password", { origin: "https://app.acme.test" })).toBe("hunter2-secret")
    for (const origin of [
      "https://docs.acme.test",
      "https://www.app.acme.test",
      "http://app.acme.test",
    ]) {
      expect(() => resolve("acme.password", { origin }), origin).toThrow()
    }
  })
})
