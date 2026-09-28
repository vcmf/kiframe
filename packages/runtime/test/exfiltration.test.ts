import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProjectYaml, parseScenarioYaml, type ProjectConfig } from "@kiframe/schema"
import { memoryBackend, Vault } from "@kiframe/vault"
import { chromium, type Browser, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { PNG } from "pngjs"
import {
  type ApprovalRequest,
  recordScenario,
  runScenario,
  screenshotForModel,
  StepError,
} from "../src/index.ts"
import { startFixtureServer } from "./fixture-server.ts"

// The vault's exfiltration suite (APPROACHES §7.4, M1-7): hostile pages try to get a typed secret
// out through the take, the reports, another field, another origin or the runtime's own page code.

// URL-special characters: its encoded forms differ from it (a space, a slash, an ampersand).
const SECRET = "hunter2 Very/secret&!"
const TMP = mkdtempSync(join(tmpdir(), "kiframe-exfil-"))
const tmp = (name: string) => mkdtempSync(join(TMP, `${name}-`))
let server: Awaited<ReturnType<typeof startFixtureServer>>
let browser: Browser
let page: Page
let project: ProjectConfig

beforeAll(async () => {
  server = await startFixtureServer()
  browser = await chromium.launch()
  project = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
})
afterAll(async () => {
  await browser.close()
  await server.close()
  // Raw takes hold unblurred frames of the test secret: never left behind.
  rmSync(TMP, { recursive: true, force: true })
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

// The user approves every step here: the hostile pages are what's being tested, past the grant.
const approving = (v: Vault) => ({
  scope: "project-1",
  sceneId: "exfil",
  resolveSecret: v.resolver(),
  requestApproval: async (request: ApprovalRequest) => (
    await v.approve(request.secret, request.use),
    true
  ),
})

const take = async (path: string) => {
  const dir = join(tmp("take"), "take")
  const v = await vault()
  return recordScenario(page, typePassword(path), project, {
    outDir: dir,
    ...approving(v),
    timeoutMs: 1500,
  })
}

describe("exfiltration", () => {
  it("a page mirroring the secret into text and its URL: blurred, never in the take", async () => {
    const t = await take("/evil-mirror")
    expect(await page.locator("#echo").textContent()).toContain(SECRET)
    expect(t.events.some((e) => e.kind === "sensitive" && e.why === "secret-text")).toBe(true)
    // Every text file the take wrote (events, cursor, meta, warnings), in every encoding the page
    // used (its path and its query).
    const variants = [
      SECRET,
      encodeURIComponent(SECRET),
      new URLSearchParams({ v: SECRET }).toString().slice(2),
      "hunter2",
    ].map((v) => v.toLowerCase())
    for (const file of readdirSync(t.dir)) {
      const path = join(t.dir, file)
      if (statSync(path).isDirectory() || !/\.(json|jsonl)$/.test(file)) continue
      const content = readFileSync(path, "utf8").toLowerCase()
      for (const v of variants) expect(content, file).not.toContain(v)
    }
  })

  it("the model's screenshot of that page has the mirrored secret painted over", async () => {
    await page.goto(`${server.url}/evil-mirror`)
    await page.locator("#pw").fill(SECRET)
    const echo = await page.locator("#echo").evaluate((el) => {
      // The mirrored secret's own box (after "You typed "), not the whole paragraph.
      const range = document.createRange()
      const text = el.firstChild as Text
      range.setStart(text, "You typed ".length)
      range.setEnd(text, text.length)
      const r = range.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    })
    const png = PNG.sync.read(await screenshotForModel(page, [SECRET]))
    // Every pixel of the secret's box is painted over.
    for (let y = Math.ceil(echo.y); y < Math.floor(echo.y + echo.height); y++) {
      for (let x = Math.ceil(echo.x); x < Math.floor(echo.x + echo.width); x++) {
        const i = (y * png.width + x) * 4
        expect([png.data[i], png.data[i + 1], png.data[i + 2]]).toEqual([40, 40, 40])
      }
    }
  })

  it("a page moving focus to another field: nothing typed anywhere", async () => {
    const v = await vault()
    const run = runScenario(page, typePassword("/evil-focus"), project, {
      ...approving(v),
      timeoutMs: 1000,
    })
    await expect(run).rejects.toBeInstanceOf(StepError)
    expect(await page.locator("#c").inputValue()).toBe("")
    expect(await page.locator("#pw").inputValue()).toBe("")
  })

  it("a page leaving for another origin: refused, the secret never typed there", async () => {
    const v = await vault()
    const error = await runScenario(page, typePassword("/evil-leave"), project, {
      ...approving(v),
      timeoutMs: 1500,
    }).catch((e: unknown) => e)
    // Whenever the page left (before or after the checks), the write went to the approved element
    // or nowhere: never into the other origin's field.
    await page.waitForURL(/localhost/)
    expect(await page.locator("#pw").inputValue()).toBe("")
    expect(String(error)).not.toContain("hunter2")
  })

  it("the runtime's in-page code never hands the page a secret value", async () => {
    const dir = join(tmp("take"), "take")
    const v = await vault()
    await recordScenario(page, typePassword("/evil-spy"), project, {
      outDir: dir,
      ...approving(v),
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
  it("never touches Playwright's trace API (traces record fill arguments in plain text)", () => {
    const root = join(import.meta.dirname, "..", "..", "..")
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const path = join(dir, d.name)
        if (d.isDirectory()) return d.name === "node_modules" ? [] : sources(path)
        return /\.(ts|tsx|js|mjs)$/.test(d.name) ? [path] : []
      })
    const dirs = ["packages", "apps", "scripts"].map((d) => join(root, d))
    const files = dirs.flatMap((d) => sources(d)).filter((f) => !/[/\\]test[/\\]|\.test\./.test(f))
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toMatch(/tracing/)
  })
})
