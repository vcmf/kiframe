import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProjectYaml, parseScenarioYaml, type ProjectConfig } from "@kiframe/schema"
import { memoryBackend, Vault } from "@kiframe/vault"
import { chromium, type Browser, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  hardenedLaunchOptions,
  recordScenario,
  runScenario,
  screenshotForModel,
  StepError,
} from "../src/index.ts"
import { startFixtureServer } from "./fixture-server.ts"

// The vault's exfiltration suite (APPROACHES §7.4, M1-7): hostile pages try to get a typed secret
// out through the take, the reports, another field, another origin or the runtime's own page code.

const SECRET = "hunter2-Very-secret"
let server: Awaited<ReturnType<typeof startFixtureServer>>
let browser: Browser
let page: Page
let project: ProjectConfig

beforeAll(async () => {
  server = await startFixtureServer()
  browser = await chromium.launch(hardenedLaunchOptions())
  project = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
})
afterAll(async () => {
  await browser.close()
  await server.close()
})
beforeEach(async () => {
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } })
  page = await context.newPage()
  return () => context.close()
})

const typePassword = (path: string) =>
  parseScenarioYaml(`version: 1
setup: [{ action: goto, url: ${path} }]
steps:
  - { id: pw, action: type, target: { by: label, name: Password }, value: "{{secrets.acme.password}}" }
  - { id: after, action: pause, ms: 400 }
`)

const vault = async () => {
  const v = Vault.open(
    join(mkdtempSync(join(tmpdir(), "kiframe-vault-")), "vault.json"),
    memoryBackend(),
  )
  await v.request(
    { name: "acme.password", kind: "password", origin: new URL(server.url).origin, reason: "test" },
    () => Promise.resolve(SECRET),
  )
  return v
}

const take = async (path: string) => {
  const dir = join(mkdtempSync(join(tmpdir(), "kiframe-exfil-")), "take")
  const v = await vault()
  return recordScenario(page, typePassword(path), project, {
    outDir: dir,
    resolveSecret: v.resolver(),
    timeoutMs: 1500,
  })
}

describe("exfiltration", () => {
  it("a page mirroring the secret into text and its URL: blurred, never in the take", async () => {
    const t = await take("/evil-mirror")
    expect(await page.locator("#echo").textContent()).toContain(SECRET)
    const events = JSON.stringify(t.events)
    for (const variant of [SECRET, encodeURIComponent(SECRET), SECRET.toLowerCase()]) {
      expect(events.toLowerCase()).not.toContain(variant.toLowerCase())
    }
    expect(t.events.some((e) => e.kind === "sensitive" && e.why === "secret-text")).toBe(true)
    expect(JSON.stringify(t.warnings)).not.toContain(SECRET)
  })

  it("the model's screenshot of that page has the mirrored secret painted over", async () => {
    await page.goto(`${server.url}/evil-mirror`)
    await page.locator("#pw").fill(SECRET)
    const before = await page.screenshot({ type: "png" })
    const shot = await screenshotForModel(page, [SECRET])
    expect(shot.equals(before)).toBe(false)
  })

  it("a page moving focus to another field: nothing typed anywhere", async () => {
    const v = await vault()
    const run = runScenario(page, typePassword("/evil-focus"), project, {
      resolveSecret: v.resolver(),
      timeoutMs: 1000,
    })
    await expect(run).rejects.toBeInstanceOf(StepError)
    expect(await page.locator("#c").inputValue()).toBe("")
    expect(await page.locator("#pw").inputValue()).toBe("")
  })

  it("a page leaving for another origin: refused, the secret never typed there", async () => {
    const v = await vault()
    const error = await runScenario(page, typePassword("/evil-leave"), project, {
      resolveSecret: v.resolver(),
      timeoutMs: 1500,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StepError)
    expect(String(error)).not.toContain(SECRET)
    // It did leave: the field on the other origin is empty.
    expect(new URL(page.url()).hostname).toBe("localhost")
    expect(await page.locator("#pw").inputValue()).toBe("")
  })

  it("the runtime's in-page code never hands the page a secret value", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kiframe-exfil-")), "take")
    const v = await vault()
    await recordScenario(page, typePassword("/evil-spy"), project, {
      outDir: dir,
      resolveSecret: v.resolver(),
      knownSecretValues: ["bob@acme.com"],
      timeoutMs: 1500,
    })
    await screenshotForModel(page, [SECRET, "bob@acme.com"])
    const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)
    expect(seen.length).toBeGreaterThan(0)
    for (const s of seen) {
      expect(s).not.toContain(SECRET)
      expect(s).not.toContain("bob@acme.com")
    }
  })

  it("a secret reference outside a typed value is rejected by the schema", () => {
    for (const step of [
      `{ id: a, action: goto, url: "/x?t={{secrets.acme.password}}" }`,
      `{ id: a, action: click, target: { by: text, text: "{{secrets.acme.password}}" } }`,
      `{ id: a, action: pause, ms: 1, caption: "{{secrets.acme.password}}" }`,
      `{ id: a, action: evaluate, script: "document.cookie" }`,
    ]) {
      expect(() => parseScenarioYaml(`version: 1\nsteps: [${step}]\n`)).toThrow()
    }
  })
})

describe("hardening", () => {
  it("never starts a Playwright trace (traces record fill arguments in plain text)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs")
    const src = join(import.meta.dirname, "..", "src")
    for (const file of readdirSync(src)) {
      expect(readFileSync(join(src, file), "utf8")).not.toMatch(/\.tracing\b/)
    }
  })

  it("merges its flags into the caller's --disable-features", () => {
    const { args } = hardenedLaunchOptions({ args: ["--disable-features=Foo", "--mute-audio"] })
    const features = args?.filter((a) => a.startsWith("--disable-features=")) ?? []
    expect(features).toHaveLength(1)
    expect(features[0]).toContain("Foo")
    expect(features[0]).toContain("PasswordLeakDetection")
    expect(args).toContain("--mute-audio")
  })
})
