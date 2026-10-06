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
import { drawnSince } from "../src/run/secrets.ts"
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
    // The flex chip and the text directly in a shadow root.
    expect(await scanSecretText(page, [SECRET])).toHaveLength(2)
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
    expect(scrubSecrets(`value="it's&amp;me"`, ["it's&me"])).toBe(`value="[secret]"`)
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
    const project = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
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
    const project = parseProjectYaml(`version: 2
apps: { app: { kind: web, url: "${server.url}", viewport: { width: 800, height: 600 } } }
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
    const regions = take.events.filter(
      (e): e is Extract<typeof e, { kind: "sensitive" }> =>
        e.kind === "sensitive" && e.why === "secret-text",
    )
    // Each region: one box, never back once gone.
    for (const region of regions) expect(region.boxes).toHaveLength(1)
    // Both occurrences are on screen at the end: they last until the end of the take (so may one
    // gone after the last frame: the video holds that frame).
    expect(regions.filter((r) => r.until === take.meta.durationMs).length).toBeGreaterThanOrEqual(2)
  })
})

describe("drawnSince (SECRETS-DESIGN T2)", () => {
  it("ends a read once the page drew, and is unsure (bounded) on a frozen page", async () => {
    // Its own page: left busy for seconds after the test.
    const frozen = await browser.newPage()
    await frozen.setContent("<p>hi</p>")
    expect(await drawnSince(frozen)).toBeGreaterThan(0)
    // The page's main thread stuck for 5 s: its own timer can't fire, the Node side bounds it.
    await frozen.evaluate(() => {
      setTimeout(() => {
        const until = Date.now() + 5000
        while (Date.now() < until) {
          // busy
        }
      }, 0)
    })
    const started = Date.now()
    expect(await drawnSince(frozen)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(2500)
    void frozen.close({ runBeforeUnload: false }).catch(() => undefined)
  })
})
