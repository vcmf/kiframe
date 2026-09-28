import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseProjectYaml, parseScenarioYaml, TakeEvent } from "@kiframe/schema"
import { PNG } from "pngjs"
import { chromium, type Browser, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  matchParts,
  recordScenario,
  scanSecretText,
  screenshotForModel,
  scrubSecrets,
} from "../src/index.ts"
import { startFixtureServer } from "./fixture-server.ts"

let server: Awaited<ReturnType<typeof startFixtureServer>>
let browser: Browser
let page: Page

beforeAll(async () => {
  server = await startFixtureServer()
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
  await server.close()
})
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  return () => page.close()
})

const SECRET = "bob@acme.com"

describe("matchParts", () => {
  it("finds a value split across the parts of one block, ignoring case", () => {
    const parts = [
      { text: "Logged in as ", block: 0 },
      { text: "BOB@", block: 0 },
      { text: "acme.com", block: 0 },
      { text: "bob@acme.com", block: 1 },
    ]
    expect(matchParts(parts, [SECRET])).toEqual([
      [
        { part: 1, start: 0, end: 4 },
        { part: 2, start: 0, end: 8 },
      ],
      [{ part: 3, start: 0, end: 12 }],
    ])
  })

  it("keeps offsets exact when the case changes a string's length", () => {
    expect(matchParts([{ text: "İstanbul: bob@acme.com", block: 0 }], [SECRET])).toEqual([
      [{ part: 0, start: 10, end: 22 }],
    ])
  })

  it("never joins two blocks", () => {
    expect(
      matchParts(
        [
          { text: "bob@", block: 0 },
          { text: "acme.com", block: 1 },
        ],
        [SECRET],
      ),
    ).toEqual([])
  })
})

describe("scanSecretText", () => {
  it("finds visible text and field values, not hidden text or password inputs", async () => {
    await page.goto(`${server.url}/whoami`)
    await page.getByText("Hi BOB@ACME.COM").waitFor()
    const boxes = await scanSecretText(page, [SECRET])
    // The split text, the text field, the late text (any case); not the hidden one or the password.
    expect(boxes).toHaveLength(3)
    const field = await page.locator("#f").boundingBox()
    expect(boxes).toContainEqual(field)
    for (const b of boxes) expect(b.width).toBeGreaterThan(0)
  })

  it("matches values with spaces however they're rendered, and across flex items", async () => {
    await page.goto(`${server.url}/names`)
    expect(await scanSecretText(page, ["Bob Smith"])).toHaveLength(2)
    expect(await scanSecretText(page, [SECRET])).toHaveLength(1)
  })

  it("paints secrets over in the model's screenshot", async () => {
    await page.goto(`${server.url}/whoami`)
    await page.getByText("Hi BOB@ACME.COM").waitFor()
    const [box] = await scanSecretText(page, [SECRET])
    const png = PNG.sync.read(await screenshotForModel(page, [SECRET]))
    const x = Math.round(box!.x + box!.width / 2)
    const y = Math.round(box!.y + box!.height / 2)
    const i = (y * png.width + x) * 4
    expect([png.data[i], png.data[i + 1], png.data[i + 2]]).toEqual([40, 40, 40])
  })
})

describe("scrubSecrets", () => {
  it("scrubs HTML-escaped values and values split by whitespace", () => {
    expect(scrubSecrets("a&amp;b&lt;c", ["a&b<c"])).toBe("[secret]")
    expect(scrubSecrets(`textbox "Email": bob@\n  acme.com`, [SECRET])).toBe(
      `textbox "Email": [secret]`,
    )
    // A longer secret split by whitespace wins over a shorter one it contains.
    expect(scrubSecrets("bob@\n  acme.com", ["bob", SECRET])).toBe("[secret]")
    // Short values aren't matched across whitespace (they'd eat ordinary words).
    expect(scrubSecrets("a b c", ["abc"])).toBe("a b c")
  })
})

describe("recording", () => {
  it("blurs a secret shown as text, from the scan before it was seen", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kiframe-scan-")), "take")
    const project = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const take = await recordScenario(
      page,
      parseScenarioYaml(`version: 1
setup: [{ action: goto, url: /whoami }]
steps: [{ id: wait, action: pause, ms: 900 }]
`),
      project,
      { outDir: dir, knownSecretValues: [SECRET], timeoutMs: 1500 },
    )
    const events = readFileSync(join(take.dir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => TakeEvent.parse(JSON.parse(l)))
    const text = events.filter((e) => e.kind === "sensitive" && e.why === "secret-text")
    expect(
      new Set(text.map((e) => (e.kind === "sensitive" ? e.id : ""))).size,
    ).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(events)).not.toContain(SECRET)
    const ts = events.map((e) => e.t)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
  })

  it("keeps every occurrence blurred through re-renders: a region never comes back", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "kiframe-scan-")), "take")
    const project = parseProjectYaml(`version: 1
target: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } }
defaults: { pacing: { settleMs: 0, cursor: instant, typing: instant } }
`)
    const take = await recordScenario(
      page,
      parseScenarioYaml(`version: 1
setup: [{ action: goto, url: /flicker }]
steps: [{ id: wait, action: pause, ms: 1500 }]
`),
      project,
      { outDir: dir, knownSecretValues: [SECRET], timeoutMs: 1500 },
    )
    const regions = new Map<string, boolean[]>()
    for (const e of take.events) {
      if (e.kind !== "sensitive" || e.why !== "secret-text") continue
      const shown = e.rect.w > 0 && e.rect.h > 0
      regions.set(e.id, [...(regions.get(e.id) ?? []), shown])
    }
    // Each region: shown once, then at most gone once.
    for (const states of regions.values()) {
      expect(states[0]).toBe(true)
      expect(states.slice(1).every((s) => !s)).toBe(true)
      expect(states.length).toBeLessThanOrEqual(2)
    }
    // Both occurrences are on screen at the end: two regions still open.
    const open = [...regions.values()].filter((s) => s.length === 1)
    expect(open).toHaveLength(2)
  })
})
