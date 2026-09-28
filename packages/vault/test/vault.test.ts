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
  await o.vault.approve("acme.password", USE)
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
    await vault.approve("acme.key", use)
    // Stored with its literal segments hashed (§3 A1): `*` kept.
    expect(vault.grants()[0]?.pathPattern).toMatch(/^\/[0-9a-f]{64}\/\*\/[0-9a-f]{64}$/)
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
    await vault.approve("acme.user", textarea)
    expect(await refusal(vault.resolve("acme.user", textarea))).toBe("kind")
    // Interrupt rules only type passwords.
    const inInterrupt = {
      ...USE,
      stepKey: "interrupt:relogin",
      element: { tag: "input" as const, type: "email", label: "Email" },
    }
    await vault.approve("acme.user", inInterrupt)
    expect(await refusal(vault.resolve("acme.user", inInterrupt))).toBe("kind")
  })

  it("revoking a grant or removing the secret makes the step ask again", async () => {
    const { vault } = await approved()
    vault.revoke(USE.scope, USE.stepKey, "acme.password")
    expect(await refusal(vault.resolve("acme.password", USE))).toBe("no-grant")
    await vault.approve("acme.password", USE)
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

describe("Vault: grants, round 1 review", () => {
  it("an interrupt rule's grant covers every path on its origin", async () => {
    const { vault } = open()
    await vault.request(form, provide("v"))
    const use = { ...USE, stepKey: "interrupt:relogin" }
    await vault.approve("acme.password", use)
    expect(await vault.resolve("acme.password", { ...use, path: "/dashboard/settings" })).toBe("v")
  })

  it("keeps one grant per origin for the same step (staging and prod)", async () => {
    const { vault } = open()
    await vault.request(form, provide("v"))
    await vault.request({ ...form, origin: "https://app.acme.com" }, provide("v"))
    await vault.approve("acme.password", USE)
    await vault.approve("acme.password", { ...USE, origin: "https://app.acme.com" })
    expect(await vault.resolve("acme.password", USE)).toBe("v")
    expect(await vault.resolve("acme.password", { ...USE, origin: "https://app.acme.com" })).toBe(
      "v",
    )
  })

  it("says which part of a grant stopped matching", async () => {
    const { vault } = await approved()
    const message = (change: Partial<SecretUse>) =>
      vault.resolve("acme.password", { ...USE, ...change }).catch((e: unknown) => String(e))
    expect(await message({ stepKey: "preset:login/other" })).toMatch(/isn't approved for this step/)
    expect(await message({ target: '{"by":"label","name":"Pass"}' })).toMatch(/target changed/)
    expect(await message({ path: "/elsewhere" })).toMatch(/other pages/)
    expect(await message({ element: { tag: "input", type: "password", label: "Pass" } })).toMatch(
      /type or label changed/,
    )
  })

  it("opens an M1-5 file (field bindings are dropped, not an unreadable vault)", () => {
    const { path } = open()
    const old = join(path, "..", "..", "m15.json")
    writeFileSync(
      old,
      JSON.stringify({
        version: 1,
        secrets: [
          {
            name: "acme.password",
            kind: "password",
            origins: [ORIGIN],
            field: { inputType: "password" },
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
    )
    expect(Vault.open(old, memoryBackend()).list()).toMatchObject([{ name: "acme.password" }])
  })
})

describe("Vault: grants, round 3 review", () => {
  it("stores nothing page-derived in the clear: path segments and labels are keyed hashes", async () => {
    const { vault, path, backend } = open()
    await vault.request(form, provide("hunter2-secret"))
    const use = {
      ...USE,
      path: "/invite/bob%40acme.com/accept",
      element: { tag: "input" as const, type: "password", label: "Password for bob@acme.com" },
    }
    await vault.approve("acme.password", use)
    const file = readFileSync(path, "utf8")
    expect(file).not.toMatch(/bob|invite|accept|Password for/)
    expect(await vault.resolve("acme.password", use)).toBe("hunter2-secret")
    // Exactly as approved: another label, another literal segment, refused.
    expect(
      await refusal(
        vault.resolve("acme.password", { ...use, path: "/invite/eve%40acme.com/accept" }),
      ),
    ).toBe("no-grant")
    expect(
      await refusal(
        vault.resolve("acme.password", { ...use, element: { ...use.element, label: "Password" } }),
      ),
    ).toBe("no-grant")
    // The hash key survives reopening (the keychain has it).
    expect(await Vault.open(path, backend).resolve("acme.password", use)).toBe("hunter2-secret")
  })

  it("doesn't depend on which secrets exist: adding one keeps every grant as it was", async () => {
    const { vault } = await approved()
    await vault.request({ ...form, name: "acme.user", kind: "username" }, provide("login"))
    expect(await vault.resolve("acme.password", USE)).toBe("hunter2-secret")
  })

  it("keeps a grant per page for one step (a preset landing on /en/login and /fr/login)", async () => {
    const { vault } = open()
    await vault.request(form, provide("v"))
    await vault.approve("acme.password", { ...USE, path: "/en/login" })
    await vault.approve("acme.password", { ...USE, path: "/fr/login" })
    expect(await vault.resolve("acme.password", { ...USE, path: "/en/login" })).toBe("v")
    expect(await vault.resolve("acme.password", { ...USE, path: "/fr/login" })).toBe("v")
  })
})

describe("Vault: the grants' hash key", () => {
  it("is one key for concurrent first uses, kept across reopening", async () => {
    const { vault, path, backend } = open()
    await vault.request(form, provide("v"))
    await Promise.all([
      vault.approve("acme.password", USE),
      vault.approve("acme.password", { ...USE, path: "/fr/login" }),
    ])
    const reopened = Vault.open(path, backend)
    expect(await reopened.resolve("acme.password", USE)).toBe("v")
    expect(await reopened.resolve("acme.password", { ...USE, path: "/fr/login" })).toBe("v")
  })

  it("is never replaced silently while grants exist: a lost key asks to approve again", async () => {
    const { vault, path, backend } = await approved()
    backend.values.delete("#grant-hash-key")
    const error = await Vault.open(path, backend)
      .resolve("acme.password", USE)
      .catch((e: unknown) => e)
    expect(String(error)).toMatch(/key of the vault's approvals is missing/)
    expect(vault.grants()).toHaveLength(1)
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
