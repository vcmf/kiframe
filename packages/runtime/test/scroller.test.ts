import { chromium, type Browser } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { viewOf } from "../src/scroller.ts"

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(() => browser.close())

describe("where the view is", { timeout: 30_000 }, () => {
  it("says scrolled after a small scroll down a very long page, and the section read", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    const filler = (n: number) => `<div style="height: ${n}px"></div>`
    // A pinned heading later in the page's order: never the section read.
    await page.setContent(
      `<h1>Top</h1>${filler(300)}<h2>Early life</h2>${filler(200_000)}<h2>Honours</h2>${filler(300)}` +
        `<h2 style="position: fixed; top: 0; right: 0">Pinned contents</h2>`,
    )
    expect(await viewOf(page)).toEqual({ scrolled: false, percent: 0, heading: "Top" })
    await page.evaluate(() => scrollTo(0, 400))
    // 400 px of 200 000: 0% once rounded, but scrolled, in its section.
    expect(await viewOf(page)).toEqual({ scrolled: true, percent: 0, heading: "Early life" })
    await page.evaluate(() => scrollTo(0, document.body.scrollHeight))
    expect(await viewOf(page)).toMatchObject({ scrolled: true, percent: 100, heading: "Honours" })
    await page.close()
  })

  it("says nothing of a page that doesn't scroll", async () => {
    const page = await browser.newPage()
    await page.setContent("<h1>Short</h1>")
    expect(await viewOf(page)).toBeUndefined()
    await page.close()
  })
})
