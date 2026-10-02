import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { memoryBackend, type SecretUse } from "@kiframe/vault"
import { describe, expect, it } from "vitest"
import { Secrets } from "../src/main/secrets.ts"

const APP = "https://app.test"
const make = () => {
  const backend = memoryBackend()
  const path = join(mkdtempSync(join(tmpdir(), "kiframe-secrets-")), "vault.json")
  return { secrets: new Secrets(path, backend), backend, path }
}
const use: SecretUse = {
  scope: "folder-0123456789abcdef",
  stepKey: "scene:scene-0123456789ab/steps/pw",
  origin: APP,
  path: "/login",
  target: '{"by":"label","name":"Password"}',
  element: { tag: "input", type: "password", label: "Password" },
}

describe("the app's secrets", () => {
  it("keeps a value in the keychain only: listed by name, kind and whether it's here", async () => {
    const { secrets, backend } = make()
    await secrets.add({ name: "acme.password", kind: "password", value: "hunter2-secret" }, APP)
    const listed = secrets.list(APP)
    expect(listed).toEqual([
      { name: "acme.password", kind: "password", origins: [APP], provided: true },
    ])
    expect(JSON.stringify(listed)).not.toContain("hunter2-secret")
    expect(backend.values.get("acme.password")).toBe("hunter2-secret")
    expect(secrets.names(APP)).toEqual([{ name: "acme.password", provided: true }])
    expect([...secrets.knownValues()]).toEqual(["hunter2-secret"])
  })

  it("lists a project only the secrets usable on its app", async () => {
    const { secrets } = make()
    await secrets.add({ name: "acme.password", kind: "password", value: "a" }, APP)
    await secrets.add({ name: "other.key", kind: "api_key", value: "b" }, "https://other.test")
    expect(secrets.list(APP).map((s) => s.name)).toEqual(["acme.password"])
    // Every value is still known (over-scrubbing is safe).
    expect(secrets.knownValues().size).toBe(2)
  })

  it("refuses a name that isn't a secret name, and resolves only an approved use", async () => {
    const { secrets } = make()
    await expect(
      secrets.add({ name: "hunter2 secret!", kind: "password", value: "x" }, APP),
    ).rejects.toThrow()
    await secrets.add({ name: "acme.password", kind: "password", value: "hunter2-secret" }, APP)
    await expect(secrets.resolve("acme.password", use)).rejects.toMatchObject({
      reason: "no-grant",
    })
    await secrets.approve("acme.password", use)
    expect(await secrets.resolve("acme.password", use)).toBe("hunter2-secret")
  })

  it("loads every value at start (a reopened app knows them), and forgets a removed one", async () => {
    const { secrets, backend, path } = make()
    await secrets.add({ name: "acme.password", kind: "password", value: "hunter2-secret" }, APP)
    const again = new Secrets(path, backend)
    expect(again.knownValues().size).toBe(0)
    await again.ready()
    expect([...again.knownValues()]).toEqual(["hunter2-secret"])
    await again.remove("acme.password")
    expect(again.list(APP)).toEqual([])
    expect(again.knownValues().size).toBe(0)
    expect(backend.values.has("acme.password")).toBe(false)
  })
})
