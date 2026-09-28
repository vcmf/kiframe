import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProjectYaml, parseScenarioYaml } from "@kiframe/schema"
import { chromium, type Browser } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { approvalPolicy, recordBatch, type RunnerEvent } from "../src/index.ts"
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
  parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } }
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
      })),
      project(),
      {
        timeoutMs: 1500,
        onEvent: (e: RunnerEvent) => {
          if (e.kind === "preset_done") logins.push(e.session ? 1 : 0)
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
