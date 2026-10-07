import { PNG } from "pngjs"
import { type Browser, chromium, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { LookRefusal, maskedScreenshot } from "../src/index.ts"
import { masksIn } from "../src/look.ts"
import { startFixtureServer } from "./fixture-server.ts"

// The agent's look (APPROACHES §7.4): the live page as an image, every place a value may show
// painted over, from the browser's own snapshot. Pixel checks: a masked pixel is (40, 40, 40).

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
type Box = { x: number; y: number; width: number; height: number }

/** Every pixel of the box (shrunk a pixel) painted over. */
function covered(png: PNG, box: Box): boolean {
  for (let y = Math.ceil(box.y) + 1; y < Math.floor(box.y + box.height) - 1; y++) {
    for (let x = Math.ceil(box.x) + 1; x < Math.floor(box.x + box.width) - 1; x++) {
      const i = (y * png.width + x) * 4
      if (png.data[i] !== 40 || png.data[i + 1] !== 40 || png.data[i + 2] !== 40) return false
    }
  }
  return true
}

/** An element's box; a text element's own text box (a block spans the page). */
const boxOf = (selector: string, text = true) =>
  page
    .locator(selector)
    .first()
    .evaluate((e, text) => {
      let r = e.getBoundingClientRect()
      if (text) {
        const range = document.createRange()
        range.selectNodeContents(e)
        r = range.getBoundingClientRect()
      }
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }, text)

const shot = async (values: string[], opts = {}) =>
  PNG.sync.read((await maskedScreenshot(page, values, opts)).png)

describe("look: what is painted over", () => {
  it("what the text scrubber hides: a short value in a word, an encoded form, a split value", async () => {
    await page.setContent(`<style>p{font-size:30px;margin:4px}</style>
      <p id="a">bobby</p><p id="b">Ym9iQGFjbWUuY29t</p><p id="c">Logged in as <b>bob@</b>acme.com</p>`)
    const png = await shot(["bob", SECRET])
    const a = await boxOf("#a")
    expect(covered(png, { ...a, width: a.height })).toBe(true)
    expect(covered(png, await boxOf("#b"))).toBe(true)
    const c = await boxOf("#c b")
    expect(covered(png, c)).toBe(true)
  })

  it("text the DOM walk missed: ::before, a closed shadow root, hidden text", async () => {
    await page.setContent(`<style>p,span{font-size:30px} .pre::before{content:"bob@acme.com"}</style>
      <p class="pre" id="pre"></p><div id="host"></div><p id="h" style="opacity:0">bob@acme.com</p>`)
    await page.evaluate(() => {
      const root = document.getElementById("host")!.attachShadow({ mode: "closed" })
      root.innerHTML = `<span style="font-size:30px">bob@acme.com</span>`
    })
    const png = await shot([SECRET])
    const pre = await boxOf("#pre", false)
    expect(covered(png, { ...pre, width: 150 })).toBe(true)
    const host = await boxOf("#host", false)
    expect(covered(png, { ...host, width: 150 })).toBe(true)
    expect(covered(png, await boxOf("#h"))).toBe(true)
  })

  it("text the browser generates with no node behind it (a CSS counter), and a scrolled page", async () => {
    await page.setContent(`<style>.c{font-size:30px} .c::after{content:"pin " counter(n)}</style>
      <script>window.user = { pin: "4821" }</script>
      <div style="height:900px"></div><p id="c" class="c" style="counter-reset:n 4821"></p><div style="height:900px"></div>`)
    await page.evaluate(() => document.getElementById("c")!.scrollIntoView())
    const png = await shot(["4821"])
    const c = await boxOf("#c", false)
    // The number after "pin " (the counter's text): painted over where it shows, scrolled.
    expect(covered(png, { x: c.x + 50, y: c.y, width: 50, height: c.height })).toBe(true)
    // A value in the page's script (never painted): never masks the page.
    expect(covered(png, { x: c.x, y: c.y, width: 40, height: c.height })).toBe(false)
  })

  it("never masks a region for text that isn't shown (display: none)", async () => {
    await page.setContent(`<header id="h" style="font-size:30px"><span>Menu</span>
      <div style="display:none">bob@acme.com</div></header>`)
    const png = await shot([SECRET])
    expect(covered(png, await boxOf("#h span"))).toBe(false)
  })

  it("form controls: a listbox's other options, a closed select, a value, a placeholder, a textarea, alt text", async () => {
    await page.setContent(`<style>*{font-size:24px}</style>
      <select id="lb" size="3"><option>nobody</option><option>bob@acme.com</option></select>
      <select id="cs"><option>bob@acme.com</option></select>
      <input id="v" value="bob@acme.com" style="width:300px"> <input id="ph" placeholder="bob@acme.com" style="width:300px">
      <textarea id="ta">bob@acme.com</textarea>
      <img id="img" alt="bob@acme.com" src="/nope.png" style="width:200px;height:40px">`)
    const png = await shot([SECRET])
    // A listbox's matching row (not its first, selected one).
    const row = await page.locator("#lb option").nth(1).boundingBox()
    expect(covered(png, row!)).toBe(true)
    for (const id of ["#cs", "#v", "#ph", "#ta", "#img"]) {
      expect(covered(png, await boxOf(id, false)), id).toBe(true)
    }
  })

  it("never matches a password field's value (a guess typed there would be answered)", async () => {
    await page.setContent(
      `<input id="pw" type="password" value="bob@acme.com" style="font-size:24px;width:300px">`,
    )
    const png = await shot([SECRET])
    expect(covered(png, await boxOf("#pw", false))).toBe(false)
  })

  it("a frame holding a value whole (another site's too, when its document is read); a clean one stays", async () => {
    await page.goto(`${server.url}/`)
    const other = server.url.includes("127.0.0.1")
      ? server.url.replace("127.0.0.1", "localhost")
      : server.url.replace("localhost", "127.0.0.1")
    await page.setContent(`
      <iframe id="f1" style="width:300px;height:80px" srcdoc="<p>hi bob@acme.com</p>"></iframe>
      <iframe id="f2" style="width:300px;height:80px" srcdoc="<p>nothing here</p>"></iframe>
      <iframe id="f3" style="width:300px;height:80px" src="${other}/look-frame"></iframe>`)
    await page.waitForFunction(() => document.querySelectorAll("iframe").length === 3)
    await Promise.all(page.frames().map((f) => f.waitForLoadState()))
    const png = await shot([SECRET])
    expect(covered(png, await boxOf("#f1", false))).toBe(true)
    expect(covered(png, await boxOf("#f2", false))).toBe(false)
    expect(covered(png, await boxOf("#f3", false))).toBe(true)
  })

  it("masks a frame inside a frame by its outermost frame (a snapshot's nested documents)", () => {
    // doc 0: an iframe (node 1) holding doc 1; doc 1: an iframe (node 1) with no document (OOPIF).
    const strings = ["main", "u0", "child", "u1", "IFRAME", "HTML"]
    const doc = (frameId: number, url: number, owner?: number) => ({
      documentURL: url,
      frameId,
      nodes: {
        parentIndex: [-1, 0],
        nodeType: [1, 1],
        nodeName: [5, 4],
        ...(owner !== undefined && { contentDocumentIndex: { index: [1], value: [owner] } }),
      },
      layout: {
        nodeIndex: [0, 1],
        bounds: [
          [0, 0, 800, 600],
          [10, 20, 300, 100],
        ],
        text: [-1, -1],
      },
      textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
    })
    const { boxes } = masksIn({ strings, documents: [doc(0, 1, 1), doc(2, 3)] }, /x/g)
    expect(boxes).toEqual([{ x: 10, y: 20, width: 300, height: 100 }])
  })

  it("the project's redaction selectors, in child frames too; an unusable one is said", async () => {
    await page.setContent(`<div id="r" style="width:200px;height:50px;background:red"></div>
      <iframe id="f" style="width:300px;height:100px;border:0" srcdoc="<body style='margin:0'><div class='acct' style='width:100px;height:40px;background:red'></div></body>"></iframe>`)
    await page.frames()[1]?.waitForSelector(".acct")
    const png = await shot([], { selectors: ["#r", ".acct"] })
    expect(covered(png, await boxOf("#r", false))).toBe(true)
    const f = await boxOf("#f", false)
    expect(covered(png, { x: f.x, y: f.y, width: 100, height: 40 })).toBe(true)
    await expect(maskedScreenshot(page, [], { selectors: ["[[["] })).rejects.toBeInstanceOf(
      LookRefusal,
    )
  })
})

describe("look: the capture", () => {
  it("shows the page as the scans measured it (an animation never reset to its first frame)", async () => {
    await page.setContent(`<style>@keyframes slide { from { transform: translateX(0) } to { transform: translateX(300px) } }</style>
      <p id="a" style="font-size:30px;animation: slide 1000s linear infinite;animation-delay:-500s">bob@acme.com</p>`)
    const png = await shot([SECRET])
    const at = await boxOf("#a")
    expect(covered(png, at)).toBe(true)
    for (let y = Math.ceil(at.y); y < Math.floor(at.y + at.height); y++) {
      for (let x = Math.max(0, Math.ceil(at.x - 150)); x < Math.floor(at.x - 10); x++) {
        expect(png.data[(y * png.width + x) * 4], `${x},${y}`).toBe(255)
      }
    }
  })

  it("cuts the image to a measured box; refuses when the page or the box keeps moving", async () => {
    await page.setContent(`<div id="c" style="width:300px;height:120px;background:#eee"></div>`)
    const cut = await maskedScreenshot(page, [], {
      measure: () => page.locator("#c").boundingBox(),
    })
    expect([cut.width, cut.height]).toEqual([300, 120])
    await page.setContent(
      `<p id="m" style="position:absolute;font-size:30px">bob@acme.com</p>
       <script>let n = 0; setInterval(() => { document.getElementById("m").style.left = (n++ % 200) + "px" }, 1)</script>`,
    )
    await expect(maskedScreenshot(page, [SECRET])).rejects.toThrow()
    await expect(
      maskedScreenshot(page, [], { measure: () => page.locator("#m").boundingBox() }),
    ).rejects.toThrow()
  })

  it("gives up at once when the run is stopped mid-look (a busy page never holds the stop)", async () => {
    await page.setContent(`<p>hello</p>`)
    // The page's main thread busy for 4 s, starting now.
    await page.evaluate(() => {
      setTimeout(() => {
        const end = Date.now() + 4000
        while (Date.now() < end) {
          // busy
        }
      }, 0)
    })
    const stop = new AbortController()
    setTimeout(() => stop.abort(new Error("stopped")), 300)
    const started = Date.now()
    await expect(maskedScreenshot(page, [SECRET], { signal: stop.signal })).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("stops at once when the run is stopped", async () => {
    await page.setContent(`<p>hello</p>`)
    const stop = new AbortController()
    stop.abort()
    await expect(maskedScreenshot(page, [SECRET], { signal: stop.signal })).rejects.toThrow()
  })
})
