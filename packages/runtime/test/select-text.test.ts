import { chromium, type Browser } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { pageLib } from "../src/run/select-text.ts"

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(() => browser.close())

describe("the page side of selecting text", { timeout: 30_000 }, () => {
  it("reads again when the page re-rendered the text after it was read (never a crash)", async () => {
    const page = await browser.newPage()
    await page.setContent('<p id="row">Hello world</p>')
    const lib = await page.locator("#row").evaluateHandle(pageLib)
    expect(await lib.evaluate((l) => l.read().pieces)).toEqual(["Hello world"])
    // A live list renders the row again: the same text, a new node (the one read is detached).
    await page.evaluate(() => {
      const row = document.getElementById("row")!
      row.replaceChildren(document.createTextNode(row.textContent ?? ""))
    })
    const placed = await lib.evaluate((l) =>
      l.place({
        start: { piece: 0, offset: 0, length: 1 },
        end: { piece: 0, offset: 4, length: 1 },
      }),
    )
    expect(placed).toEqual({ ok: false, changed: true })
    await page.close()
  })
})
