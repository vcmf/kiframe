import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { memoryBackend, SecretRefusal, Vault, type FieldBinding } from "../src/index.ts"

const ORIGIN = "https://staging.acme.com"
const PASSWORD_FIELD: FieldBinding = { inputType: "password" }
const open = () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiframe-vault-")), "vault", "vault.json")
  const backend = memoryBackend()
  return { path, backend, vault: Vault.open(path, backend) }
}
const provide = (value: string | undefined) => () => Promise.resolve(value)
const form = { name: "acme.password", kind: "password", origin: ORIGIN, reason: "log in" }

describe("Vault", () => {
  it("lists names and metadata, never values", async () => {
    const { vault, path } = open()
    expect(await vault.request(form, provide("hunter2-secret"))).toBe("provided")
    expect(vault.list()).toMatchObject([
      { name: "acme.password", kind: "password", origins: [ORIGIN] },
    ])
    expect(JSON.stringify(vault.list())).not.toContain("hunter2")
    expect(readFileSync(path, "utf8")).not.toContain("hunter2")
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it("tells the agent only that the user declined", async () => {
    const { vault, backend } = open()
    expect(await vault.request(form, provide(undefined))).toBe("declined")
    expect(await vault.request(form, provide(""))).toBe("declined")
    expect(vault.list()).toEqual([])
    expect(backend.values.size).toBe(0)
  })

  it("rejects a malformed request before asking the user", async () => {
    const { vault } = open()
    let asked = false
    const ask = () => ((asked = true), Promise.resolve("x"))
    await expect(vault.request({ ...form, origin: `${ORIGIN}/login` }, ask)).rejects.toThrow()
    await expect(vault.request({ ...form, name: "{{secrets.x}}" }, ask)).rejects.toThrow()
    await expect(vault.request({ ...form, kind: "token" }, ask)).rejects.toThrow()
    expect(asked).toBe(false)
  })

  it("resolves on an allowed origin and binds the field at first use", async () => {
    const { vault, path } = open()
    await vault.request(form, provide("hunter2-secret"))
    expect(await vault.resolve("acme.password", { origin: ORIGIN, field: PASSWORD_FIELD })).toBe(
      "hunter2-secret",
    )
    // Reopened: the binding was saved.
    expect(Vault.open(path, memoryBackend()).list()[0]?.field).toEqual(PASSWORD_FIELD)
    expect(await vault.resolve("acme.password", { origin: ORIGIN, field: PASSWORD_FIELD })).toBe(
      "hunter2-secret",
    )
  })

  it("refuses another origin, another field, and an unknown secret, without the value", async () => {
    const { vault } = open()
    await vault.request(form, provide("hunter2-secret"))
    await vault.resolve("acme.password", { origin: ORIGIN, field: PASSWORD_FIELD })
    const attempts = [
      vault.resolve("acme.password", { origin: "https://evil.com", field: PASSWORD_FIELD }),
      vault.resolve("acme.password", {
        origin: ORIGIN,
        field: { inputType: "search" },
      }),
      vault.resolve("acme.password", {
        origin: ORIGIN,
        field: { ...PASSWORD_FIELD, inputType: "text" },
      }),
      vault.resolve("acme.other", { origin: ORIGIN, field: PASSWORD_FIELD }),
    ]
    for (const attempt of attempts) {
      const error = await attempt.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(SecretRefusal)
      expect(String(error)).not.toContain("hunter2")
    }
  })

  it("binds the field kind at first use; the user can unbind it", async () => {
    const { vault } = open()
    const user = { ...form, name: "acme.username", kind: "username" }
    await vault.request(user, provide("old-value"))
    await vault.resolve("acme.username", { origin: ORIGIN, field: { inputType: "email" } })
    await vault.request(user, provide("new-value"))
    expect(vault.list()[0]?.field).toEqual({ inputType: "email" })
    await expect(
      vault.resolve("acme.username", { origin: ORIGIN, field: { inputType: "textarea" } }),
    ).rejects.toThrow(/bound to another field/)
    vault.unbind("acme.username")
    expect(
      await vault.resolve("acme.username", { origin: ORIGIN, field: { inputType: "text" } }),
    ).toBe("new-value")
  })

  it("types a password only into a password field, even at first use", async () => {
    const { vault } = open()
    await vault.request(form, provide("v"))
    await expect(
      vault.resolve("acme.password", { origin: ORIGIN, field: { inputType: "text" } }),
    ).rejects.toThrow(/only goes into a password field/)
  })

  it("adds a requested origin, and removes a secret everywhere", async () => {
    const { vault, backend } = open()
    await vault.request(form, provide("v"))
    await vault.request({ ...form, origin: "https://demo.acme.com" }, provide("v"))
    expect(vault.list()[0]?.origins).toEqual([ORIGIN, "https://demo.acme.com"])
    await vault.remove("acme.password")
    expect(vault.list()).toEqual([])
    expect(backend.values.size).toBe(0)
  })

  it("refuses a secret whose value isn't on this machine (synced names only)", async () => {
    const { vault, backend } = open()
    await vault.request(form, provide("v"))
    backend.values.clear()
    await expect(
      vault.resolve("acme.password", { origin: ORIGIN, field: PASSWORD_FIELD }),
    ).rejects.toThrow(/no value on this machine/)
  })

  it("loses no update when a resolve binds during a pending request", async () => {
    const { vault } = open()
    await vault.request(form, provide("v"))
    let answer: (v: string) => void = () => undefined
    const pending = vault.request(
      { ...form, name: "acme.username", kind: "username" },
      () => new Promise<string>((resolve) => (answer = resolve)),
    )
    await vault.resolve("acme.password", { origin: ORIGIN, field: PASSWORD_FIELD })
    answer("bob")
    await pending
    const list = vault.list()
    expect(list.find((s) => s.name === "acme.password")?.field).toEqual(PASSWORD_FIELD)
    expect(list.find((s) => s.name === "acme.username")).toBeDefined()
  })

  it("never changes a secret's kind, nor asks for a value it can't record", async () => {
    const { vault, backend } = open()
    await vault.request(form, provide("old"))
    await expect(vault.request({ ...form, kind: "text" }, provide("x"))).rejects.toThrow(
      /is a password/,
    )
    for (let i = 1; i < 20; i++)
      await vault.request({ ...form, origin: `https://o${i}.acme.com` }, provide("old"))
    let asked = false
    await expect(
      vault.request(
        { ...form, origin: "https://o21.acme.com" },
        () => ((asked = true), Promise.resolve("new")),
      ),
    ).rejects.toThrow()
    expect(asked).toBe(false)
    expect(backend.values.get("acme.password")).toBe("old")
  })

  it("refuses, as a refusal, a field it can't identify", async () => {
    const { vault } = open()
    await vault.request(form, provide("v"))
    const error = await vault
      .resolve("acme.password", {
        origin: ORIGIN,
        field: { inputType: "x".repeat(500) },
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SecretRefusal)
  })

  it("gives the value to one of two concurrent first uses only", async () => {
    const { vault } = open()
    await vault.request({ ...form, name: "acme.username", kind: "username" }, provide("v"))
    const results = await Promise.allSettled([
      vault.resolve("acme.username", { origin: ORIGIN, field: { inputType: "email" } }),
      vault.resolve("acme.username", { origin: ORIGIN, field: { inputType: "search" } }),
    ])
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"])
  })

  it("never resets a metadata file it can't read", () => {
    const { path } = open()
    const bad = join(path, "..", "..", "bad.json")
    writeFileSync(bad, "{ not json")
    expect(() => Vault.open(bad, memoryBackend())).toThrow(/isn't valid JSON/)
    expect(readFileSync(bad, "utf8")).toBe("{ not json")
  })
})
