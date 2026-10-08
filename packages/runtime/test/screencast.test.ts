import { type Browser, chromium } from "playwright"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { watchScreencast } from "../src/index.ts"

// One screencast per page, shared: the recorder and the live view watch the same page at once.

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
})

/** The width of a JPEG (its SOF marker). */
function jpegWidth(data: Buffer): number {
  for (let i = 2; i + 9 < data.length;) {
    if (data[i] !== 0xff) return 0
    const marker = data[i + 1]!
    if (marker >= 0xc0 && marker <= 0xc3) return data.readUInt16BE(i + 7)
    i += 2 + data.readUInt16BE(i + 2)
  }
  return 0
}

describe("watchScreencast", () => {
  it("shares one page's screencast: both get frames, the larger size wins, the last one out stops it", async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(
      `<p id=t>0</p><script>let n=0;setInterval(()=>{document.getElementById('t').textContent=++n},30)</script>`,
    )
    const small: Buffer[] = []
    const large: Buffer[] = []
    const unSmall = await watchScreencast(
      page,
      { size: { width: 400, height: 300 }, quality: 60 },
      (f) => small.push(f.data),
    )
    await page.waitForTimeout(300)
    // A second, larger: no "already started"; both get its frames from then on.
    const unLarge = await watchScreencast(
      page,
      { size: { width: 800, height: 600 }, quality: 80 },
      (f) => large.push(f.data),
    )
    await page.waitForTimeout(400)
    expect(small.length).toBeGreaterThan(0)
    expect(large.length).toBeGreaterThan(0)
    expect(jpegWidth(large.at(-1)!)).toBe(800)
    expect(jpegWidth(small.at(-1)!)).toBe(800)
    // One leaves: the other still gets frames.
    await unSmall()
    const before = large.length
    await page.waitForTimeout(400)
    expect(large.length).toBeGreaterThan(before)
    // The last leaves: stopped (a new watcher can start it again).
    // A viewer joining a still page gets it as it is at once (it sends no frame until it changes).
    await page.evaluate(() => {
      for (let i = 0; i < 99999; i++) clearInterval(i)
    })
    await page.waitForTimeout(300)
    let joined = 0
    const unViewer = await watchScreencast(
      page,
      { size: { width: 400, height: 300 }, quality: 60, current: true },
      () => joined++,
    )
    await page.waitForTimeout(200)
    expect(joined).toBeGreaterThan(0)
    await unViewer()
    await unLarge()
    const again = await watchScreencast(
      page,
      { size: { width: 400, height: 300 }, quality: 60 },
      () => undefined,
    )
    await again()
    await page.close()
  })
})
