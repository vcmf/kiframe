import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  memoryBackend,
  pathMatches,
  pathPatternOf,
  SecretRefusal,
  Vault,
  type SecretUse,
} from "../src/index.ts"

const ORIGIN = "https://staging.acme.com"
const USE: SecretUse = {
  scope: "project-1",
  stepKey: "preset:login/password",
  origin: ORIGIN,
  path: "/login",
  target: '{"by":"label","name":"Password"}',
  element: { tag: "input", type: "password", label: "Password" },
  interrupt: false,
}
const open = () => {
  const path = join(mkdtempSync(join(tmpdir(), "kiframe-vault-")), "vault", "vault.json")
  const backend = memoryBackend()
  return { path, backend, vault: Vault.open(path, backend) }
}
const provide = (value: string | undefined) => () => Promise.resolve(value)
const form = { name: "acme.password", kind: "password", origin: ORIGIN, reason: "log in" }
const refusal = async (p: Promise<unknown>) => {
  const error = await p.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(SecretRefusal)
  expect(String(error)).not.toContain("hunter2")
  return (error as SecretRefusal).reason
}
const approved = async () => {
  const o = open()
  await o.vault.request(form, provide("hunter2-secret"))
  o.vault.approve("acme.password", USE)
  return o
}

describe("Vault: storage", () => {
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

  it("never changes a secret's kind, nor asks for a value it can't record", async () => {
    const { vault, backend } = open()
    await vault.request(form, provide("old"))
    await expect(vault.request({ ...form, kind: "text" }, provide("x"))).rejects.toThrow(
      /is a password/,
    )
    for (let i = 1; i < 20; i++) {
      await vault.request({ ...form, origin: `https://o${i}.acme.com` }, provide("old"))
    }
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

  it("never resets a metadata file it can't read", () => {
    const { path } = open()
    const bad = join(path, "..", "..", "bad.json")
    writeFileSync(bad, "{ not json")
    expect(() => Vault.open(bad, memoryBackend())).toThrow(/isn't valid JSON/)
    expect(readFileSync(bad, "utf8")).toBe("{ not json")
  })
})

describe("Vault: grants", () => {
  it("resolves only a granted use, and keeps grants across reopening", async () => {
    const { vault, path, backend } = await approved()
    expect(await vault.resolve("acme.password", USE)).toBe("hunter2-secret")
    expect(await Vault.open(path, backend).resolve("acme.password", USE)).toBe("hunter2-secret")
  })

  it("refuses an ungranted use with `no-grant` (the one an approval can fix)", async () => {
    const { vault } = open()
    await vault.request(form, provide("hunter2-secret"))
    expect(await refusal(vault.resolve("acme.password", USE))).toBe("no-grant")
  })

  it("refuses every use the grant doesn't cover", async () => {
    const { vault } = await approved()
    const cases: [Partial<SecretUse>, string][] = [
      [{ origin: "https://evil.com" }, "origin"],
      [{ scope: "project-2" }, "no-grant"],
      [{ stepKey: "scene:other/steps/password" }, "no-grant"],
      [{ path: "/community/new-post" }, "no-grant"],
      [{ target: '{"by":"label","name":"Comment"}' }, "no-grant"],
      [{ element: { tag: "input", type: "password", label: "New password" } }, "no-grant"],
      [{ element: { tag: "input", type: "text", label: "Password" } }, "kind"],
      [{ interrupt: true }, "invalid-use"],
    ]
    for (const [change, reason] of cases) {
      expect(
        await refusal(vault.resolve("acme.password", { ...USE, ...change })),
        JSON.stringify(change),
      ).toBe(reason)
    }
    expect(await refusal(vault.resolve("acme.other", USE))).toBe("unknown-secret")
  })

  it("matches a path pattern: ids become `*` by default", async () => {
    const { vault } = open()
    await vault.request({ ...form, name: "acme.key", kind: "api_key" }, provide("k"))
    const use = {
      ...USE,
      path: "/projects/8123/settings",
      element: { tag: "input" as const, type: "text", label: "API key" },
    }
    vault.approve("acme.key", use)
    expect(vault.grants()[0]?.pathPattern).toBe("/projects/*/settings")
    expect(await vault.resolve("acme.key", { ...use, path: "/projects/8177/settings" })).toBe("k")
    expect(
      await refusal(vault.resolve("acme.key", { ...use, path: "/projects/8177/settings/extra" })),
    ).toBe("no-grant")
  })

  it("applies the kind rules even with a grant", async () => {
    const { vault } = open()
    await vault.request({ ...form, name: "acme.user", kind: "username" }, provide("bob"))
    const textarea = {
      ...USE,
      element: { tag: "textarea" as const, type: "textarea", label: "Bio" },
    }
    vault.approve("acme.user", textarea)
    expect(await refusal(vault.resolve("acme.user", textarea))).toBe("kind")
    // Interrupt rules only type passwords.
    const inInterrupt = {
      ...USE,
      stepKey: "interrupt:relogin",
      interrupt: true,
      element: { tag: "input" as const, type: "email", label: "Email" },
    }
    vault.approve("acme.user", inInterrupt)
    expect(await refusal(vault.resolve("acme.user", inInterrupt))).toBe("kind")
  })

  it("revoking a grant or removing the secret makes the step ask again", async () => {
    const { vault } = await approved()
    vault.revoke(USE.scope, USE.stepKey, "acme.password")
    expect(await refusal(vault.resolve("acme.password", USE))).toBe("no-grant")
    vault.approve("acme.password", USE)
    await vault.remove("acme.password")
    expect(vault.grants()).toEqual([])
  })

  it("checks again after the keychain wait: a grant revoked meanwhile refuses", async () => {
    const { vault, backend } = await approved()
    const get = backend.get.bind(backend)
    backend.get = (name) => {
      vault.revoke(USE.scope, USE.stepKey, "acme.password")
      return get(name)
    }
    expect(await refusal(vault.resolve("acme.password", USE))).toBe("no-grant")
  })

  it("refuses a malformed use and a secret with no value on this machine", async () => {
    const { vault, backend } = await approved()
    expect(await refusal(vault.resolve("acme.password", { ...USE, stepKey: "anything" }))).toBe(
      "invalid-use",
    )
    backend.values.clear()
    expect(await refusal(vault.resolve("acme.password", USE))).toBe("no-value")
  })
})

describe("path patterns", () => {
  it("masks ids and matches one segment per `*`", () => {
    expect(pathPatternOf("/projects/8123/items/3f2a1c9e-1b2c-4d5e-8f90-123456789abc")).toBe(
      "/projects/*/items/*",
    )
    expect(pathPatternOf("/login")).toBe("/login")
    expect(pathMatches("/projects/*/settings", "/projects/1/settings")).toBe(true)
    expect(pathMatches("/projects/*/settings", "/projects//settings")).toBe(false)
    expect(pathMatches("/login", "/login/")).toBe(false)
  })
})
