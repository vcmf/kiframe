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

  it("lists nothing for another origin (never every app's names)", async () => {
    const { secrets } = make()
    await secrets.add({ name: "acme.password", kind: "password", value: "a" }, APP)
    expect(secrets.list("https://other.test")).toEqual([])
    expect(secrets.names("https://other.test")).toEqual([])
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

  it("loads every value at start (a reopened app knows them); a removed one is no longer listed", async () => {
    const { secrets, backend, path } = make()
    await secrets.add({ name: "acme.password", kind: "password", value: "hunter2-secret" }, APP)
    const again = new Secrets(path, backend)
    expect(again.knownValues().size).toBe(0)
    await again.ready()
    expect([...again.knownValues()]).toEqual(["hunter2-secret"])
    await again.remove("acme.password", APP)
    expect(again.list(APP)).toEqual([])
    // Still known until the app quits: a page still showing it is still scrubbed (R6).
    expect([...again.knownValues()]).toEqual(["hunter2-secret"])
    expect(backend.values.has("acme.password")).toBe(false)
  })

  it("keeps a replaced value known (a page may still show it), and skips one it can't read", async () => {
    const { secrets, backend, path } = make()
    await secrets.add({ name: "acme.password", kind: "password", value: "old-pw" }, APP)
    await secrets.add({ name: "acme.password", kind: "password", value: "new-pw" }, APP)
    expect([...secrets.knownValues()].sort()).toEqual(["new-pw", "old-pw"])
    await secrets.add({ name: "acme.token", kind: "api_key", value: "tok" }, APP)
    // The keychain refuses one entry (a denied prompt): the others still load, and runs still go.
    const get = backend.get.bind(backend)
    backend.get = (name) =>
      name === "acme.token" ? Promise.reject(new Error("denied")) : get(name)
    const again = new Secrets(path, backend)
    await again.ready()
    expect([...again.knownValues()]).toEqual(["new-pw"])
    expect(again.list(APP).map((s) => [s.name, s.provided])).toEqual([
      ["acme.password", true],
      ["acme.token", false],
    ])
    // The keychain answers again (the prompt allowed this time): the next run's load reads it.
    backend.get = get
    await again.ready()
    expect(again.list(APP).map((s) => s.provided)).toEqual([true, true])
    expect(again.knownValues().has("tok")).toBe(true)
  })

  it("says why a name isn't one, in words, without repeating it (it may be a value)", async () => {
    const { secrets } = make()
    const refused = await secrets
      .add({ name: "hunter2 pw", kind: "password", value: "x" }, APP)
      .catch((e: unknown) => (e as Error).message)
    expect(refused).toBe("that isn't a secret name (must be a secret name, never a secret value)")
  })

  it("never lets one app replace another's secret, nor remove it", async () => {
    const { secrets, backend } = make()
    const PROD = "https://prod.test"
    await secrets.add({ name: "acme.password", kind: "password", value: "prod-pw" }, PROD)
    await expect(
      secrets.add({ name: "acme.password", kind: "password", value: "staging-pw" }, APP),
    ).rejects.toThrow(/already a secret of https:\/\/prod\.test: pick another name/)
    expect(backend.values.get("acme.password")).toBe("prod-pw")
    await expect(secrets.remove("acme.password", APP)).rejects.toThrow(/isn't used on/)
    expect(secrets.list(PROD)).toHaveLength(1)
  })

  it("takes a secret used by two apps off one only (its approvals there)", async () => {
    const { secrets, backend, path } = make()
    await secrets.add({ name: "acme.password", kind: "password", value: "pw" }, APP)
    // A second app the user added it to (the vault keeps both origins).
    const { Vault } = await import("@kiframe/vault")
    await Vault.open(path, backend).request(
      { name: "acme.password", kind: "password", origin: "https://other.test", reason: "test" },
      () => Promise.resolve("pw"),
    )
    const reopened = new Secrets(path, backend)
    await reopened.ready()
    await reopened.approve("acme.password", use)
    // Shared with another app: a new value from this one is refused (the other's would change).
    await expect(
      reopened.add({ name: "acme.password", kind: "password", value: "new" }, APP),
    ).rejects.toThrow(/already a secret of https:\/\/other\.test/)
    await reopened.remove("acme.password", APP)
    expect(reopened.list(APP)).toEqual([])
    expect(reopened.list("https://other.test")).toHaveLength(1)
    expect(backend.values.get("acme.password")).toBe("pw")
    await expect(reopened.resolve("acme.password", use)).rejects.toThrow()
  })

  it("never removes what isn't a secret of the vault (its own keychain entries)", async () => {
    const { secrets, backend } = make()
    backend.values.set("#grant-hash-key", "k")
    await expect(secrets.remove("#grant-hash-key", APP)).rejects.toThrow()
    expect(backend.values.get("#grant-hash-key")).toBe("k")
  })
})

describe("an app removed from a project", () => {
  it("revokes that project's approvals on its site, keeping the secret", async () => {
    const { secrets } = make()
    await secrets.add({ name: "acme.password", kind: "password", value: "hunter2" }, APP)
    await secrets.approve("acme.password", use)
    expect(await secrets.resolve("acme.password", use)).toBe("hunter2")
    secrets.revokeAt(use.scope, APP)
    await expect(secrets.resolve("acme.password", use)).rejects.toThrow()
    expect(secrets.names(APP)).toEqual([{ name: "acme.password", provided: true }])
  })
})
