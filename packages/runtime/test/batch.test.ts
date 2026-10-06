import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium, type Browser } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { memoryBackend, Vault } from "@kiframe/vault"
import {
  approvalPolicy,
  type ApprovalRequest,
  recordBatch,
  type RunnerEvent,
} from "../src/index.ts"
import { startFixtureServer } from "./fixture-server.ts"

let server: Awaited<ReturnType<typeof startFixtureServer>>
let browser: Browser

beforeAll(async () => {
  server = await startFixtureServer()
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
  await server.close()
})

const project = () =>
  parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
presets:
  login:
    session: true
    steps:
      - { action: goto, url: /session }
      - { action: click, target: { by: role, role: button, name: Sign in } }
  other:
    session: true
    steps: [{ action: goto, url: /session }]
`)

const scene = (steps: string, setup = "[{ preset: login }, { action: goto, url: /session }]") =>
  parseScenarioYaml(`version: 1
setup: ${setup}
steps:
${steps}`)

const signedIn = `  - { id: check, action: expect, that: { visible: { by: text, text: Signed in, exact: true } } }\n`
const signOut = `  - { id: out, action: click, target: { by: role, role: button, name: Sign out } }\n`

describe("recordBatch", () => {
  const run = async (steps: (string | [string, string])[]) => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-batch-"))
    const logins: number[] = []
    const results = await recordBatch(
      browser,
      steps.map((s, i) => ({
        scenario: typeof s === "string" ? scene(s) : scene(...s),
        outDir: join(dir, `take-${i}`),
        sceneId: `scene-${i}`,
      })),
      project(),
      {
        timeoutMs: 1500,
        onEvent: (e: RunnerEvent) => {
          if (e.kind === "preset_done" && e.session) logins.push(1)
        },
      },
    )
    return { results, logins: logins.length }
  }

  it("logs in once, and later scenes start signed in", async () => {
    const { results, logins } = await run([signedIn, signedIn, signedIn])
    expect(results.map((r) => r.ok)).toEqual([true, true, true])
    expect(logins).toBe(1)
  })

  it("saves the session when the login is done, not what the scene did after it", async () => {
    // Scene 1 signs out on camera: scene 2 still starts from the signed-in state.
    const { results, logins } = await run([signedIn + signOut, signedIn])
    expect(results.map((r) => r.ok)).toEqual([true, true])
    expect(logins).toBe(1)
  })

  it("goes back to the page a skipped login ended on", async () => {
    // No goto after the preset: the scene relies on the page the login left it on.
    const { results, logins } = await run([
      [signedIn, "[{ preset: login }]"],
      [signedIn, "[{ preset: login }]"],
    ])
    expect(results.map((r) => r.ok)).toEqual([true, true])
    expect(logins).toBe(1)
  })

  it("gives the session only to scenes that use it", async () => {
    const signedOut = `  - { id: out, action: expect, that: { visible: { by: text, text: Signed out, exact: true } } }\n`
    const { results, logins } = await run([
      signedIn,
      [signedOut, "[{ action: goto, url: /session }]"],
      signedIn,
    ])
    expect(results.map((r) => r.ok)).toEqual([true, true, true])
    expect(logins).toBe(1)
  })

  it("doesn't reuse a session another scene's fresh login replaced", async () => {
    const { results, logins } = await run([
      signedIn,
      [`  - { id: a, action: pause, ms: 1 }\n`, "[{ preset: other }]"],
      signedIn,
    ])
    expect(results.map((r) => r.ok)).toEqual([true, true, true])
    expect(logins).toBe(3)
  })

  it("logs in again after a scene that reused the session failed", async () => {
    const missing = `  - { id: nope, action: click, target: { by: role, role: button, name: Missing } }\n`
    const { results, logins } = await run([signedIn, missing, signedIn])
    expect(results.map((r) => r.ok)).toEqual([true, false, true])
    expect(logins).toBe(2)
  })
})

describe("recordBatch and secret approvals", () => {
  it("keys each scene's secret steps by its own scene id: one approval never serves another", async () => {
    const vault = Vault.open(
      join(mkdtempSync(join(tmpdir(), "kiframe-vault-")), "vault.json"),
      memoryBackend(),
    )
    await vault.request(
      { name: "acme.password", kind: "password", origin: new URL(server.url).origin, reason: "t" },
      () => Promise.resolve("hunter2-secret"),
    )
    const dir = mkdtempSync(join(tmpdir(), "kiframe-batch-"))
    const typing = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: /login-form }]
steps:
  - { id: pw, action: type, target: { by: label, name: Password input }, value: "{{secrets.acme.password}}" }
`)
    const asked: string[] = []
    const results = await recordBatch(
      browser,
      [0, 1].map((i) => ({
        scenario: typing,
        outDir: join(dir, `take-${i}`),
        sceneId: `scene-${i}`,
      })),
      project(),
      {
        timeoutMs: 1500,
        scope: "project-1",
        resolveSecret: vault.resolver(),
        requestApproval: async (request: ApprovalRequest) => {
          asked.push(request.use.stepKey)
          await vault.approve(request.secret, request.use)
          return true
        },
      },
    )
    expect(results.map((r) => r.ok)).toEqual([true, true])
    expect(asked).toEqual(["scene:scene-0/steps/pw", "scene:scene-1/steps/pw"])
    // Two recordings, each asking once (a screenshot for the prompt): slow on CI runners.
  }, 30_000)
})

describe("recordBatch known values", () => {
  it("carries the values a scene resolved to the next scenes (paste refused there too)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-batch-"))
    const typing = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: /login-form }]
steps:
  - { id: pw, action: type, target: { by: label, name: Password input }, value: "{{secrets.acme.password}}" }
`)
    const pasting = parseScenarioYaml(`version: 1
setup: [{ action: goto, url: /login-form }]
steps:
  - { id: e, action: click, target: { by: label, name: Email } }
  - { id: k, action: press, keys: "Mod+v" }
`)
    const results = await recordBatch(
      browser,
      [
        { scenario: typing, outDir: join(dir, "a"), sceneId: "a" },
        { scenario: pasting, outDir: join(dir, "b"), sceneId: "b" },
      ],
      project(),
      { timeoutMs: 1500, scope: "project-1", resolveSecret: () => "hunter2-secret" },
    )
    expect(results[0]?.ok).toBe(true)
    expect(results[1]?.ok).toBe(false)
    expect(String(results[1]?.ok === false ? results[1].error : "")).toMatch(/no paste/)
  })
})

describe("recordBatch scene ids", () => {
  it("fails a scene with an invalid id or an earlier scene's, not the batch", async () => {
    const s = scene(signedIn)
    const results = await recordBatch(
      browser,
      [
        { scenario: s, outDir: mkdtempSync(join(tmpdir(), "kiframe-batch-")), sceneId: "same" },
        { scenario: s, outDir: mkdtempSync(join(tmpdir(), "kiframe-batch-")), sceneId: "same" },
        { scenario: s, outDir: mkdtempSync(join(tmpdir(), "kiframe-batch-")), sceneId: "other" },
      ],
      project(),
    )
    expect(results.map((r) => r.ok)).toEqual([true, false, true])
    expect(String(results[1]?.ok === false ? results[1].error : "")).toMatch(
      /earlier scene .* "same"/,
    )
    const [bad] = await recordBatch(
      browser,
      [{ scenario: s, outDir: mkdtempSync(join(tmpdir(), "kiframe-batch-")), sceneId: "a/b.yaml" }],
      project(),
    )
    expect(String(bad?.ok === false ? bad.error : "")).toMatch(/isn't a scene id/)
  })
})

describe("recordBatch contexts", () => {
  it("never gives the page clipboard permissions", async () => {
    await expect(
      recordBatch(browser, [], project(), { context: { permissions: ["clipboard-read"] } }),
    ).rejects.toThrow(/never get clipboard permissions/)
  })
})

describe("approvalPolicy", () => {
  const teardown = { phase: "teardown" as const, index: 0, action: "click", cleanup: true as const }
  const cleanup = {
    phase: "setup" as const,
    index: 2,
    action: "ensure: click",
    cleanup: true as const,
  }
  const step = { phase: "steps" as const, index: 0, action: "click" }
  const interrupt = { ...teardown, interrupt: "cookies" }

  it("pre-approves teardowns and ensure cleanups on a sandbox that allows it", async () => {
    const policy = approvalPolicy({ sandbox: true, preApproveTeardown: true })
    expect(await policy(teardown)).toBe(true)
    expect(await policy(cleanup)).toBe(true)
    expect(await policy(step)).toBe(false)
    expect(await policy(interrupt)).toBe(false)
    // `ensure` going back through the setup isn't a cleanup: a risky setup step still asks.
    expect(await policy({ phase: "setup", index: 2, action: "ensure (back): click" })).toBe(false)
  })

  it("asks for everything elsewhere, and refuses without a way to ask", async () => {
    const asked: string[] = []
    const policy = approvalPolicy({ sandbox: true, preApproveTeardown: false }, (s) => {
      asked.push(s.phase)
      return true
    })
    expect(await policy(teardown)).toBe(true)
    expect(asked).toEqual(["teardown"])
    expect(await approvalPolicy({ sandbox: false, preApproveTeardown: true })(teardown)).toBe(false)
  })
})
