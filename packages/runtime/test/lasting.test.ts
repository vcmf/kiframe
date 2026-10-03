import { chromium, type Browser, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type ElementHint, lastingLocator } from "../src/index.ts"

let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(() => browser.close())
beforeEach(async () => {
  page = await browser.newPage()
  await page.setContent(`
    <h1>Projects</h1>
    <button>Save</button>
    <ul><li>Acme <button>Delete</button></li><li>Zeta <button>Delete</button></li></ul>
    <input placeholder="Search projects">
    <div class="card" onclick="0">Open the Acme board</div>
    <div id="logo-box" style="width:40px;height:20px;background:#ccc"></div>
    <div id="r42" style="width:40px;height:20px;background:#ccc"></div>
    <button style="display:none">Hidden thing</button>
    <menu><button>Delete</button></menu>
    <section><button id="archive">Archive</button><button>Archive</button></section>`)
  return () => page.close()
})

const el = async (selector: string) => {
  const handle = await page.$(selector)
  if (handle === null) throw new Error(`no ${selector}`)
  return handle
}
const lasting = async (selector: string, hint?: ElementHint) =>
  lastingLocator(page, await el(selector), hint)

describe("a lasting locator for an element the agent pointed at", () => {
  it("names it by role and name when that finds it alone", async () => {
    expect(await lasting("button", { role: "button", name: "Save" })).toEqual({
      locator: { by: "role", role: "button", name: "Save", exact: true },
    })
  })

  it("says its place among look-alikes (nth, visible matches only)", async () => {
    expect(await lasting("li:nth-child(2) button", { role: "button", name: "Delete" })).toEqual({
      locator: { by: "role", role: "button", name: "Delete", exact: true },
      nth: 1,
    })
  })

  it("uses the placeholder of an unnamed field, the text of an element with no role", async () => {
    expect(await lasting("input", { role: "textbox" })).toEqual({
      locator: { by: "placeholder", text: "Search projects" },
    })
    expect(await lasting(".card", { role: "generic" })).toEqual({
      locator: { by: "text", text: "Open the Acme board", exact: true },
    })
  })

  it("falls back to an id written by hand, never a generated one", async () => {
    expect(await lasting("#logo-box", { role: "generic" })).toEqual({
      locator: { by: "css", selector: "#logo-box" },
    })
    expect(await lasting("#r42", { role: "generic" })).toMatchObject({
      error: expect.stringMatching(/no lasting locator/) as unknown,
    })
  })

  it("prefers an id written by hand to a place among look-alikes", async () => {
    expect(await lasting("#archive", { role: "button", name: "Archive" })).toEqual({
      locator: { by: "css", selector: "#archive" },
    })
  })

  it("gives no place among look-alikes where a locator can't take one", async () => {
    const second = "li:nth-child(2) button"
    expect(
      await lastingLocator(
        page,
        await el(second),
        { role: "button", name: "Delete" },
        { nth: false },
      ),
    ).toEqual({ error: expect.stringMatching(/can't say which of several look-alikes/) as unknown })
  })

  it("refuses an element of another page than the step's", async () => {
    const other = await browser.newPage()
    try {
      expect(
        await lastingLocator(other, await el("button"), { role: "button", name: "Save" }),
      ).toEqual({
        error: expect.stringMatching(/on another page than the one the step runs on/) as unknown,
      })
    } finally {
      await other.close()
    }
  })

  it("refuses an element that's hidden or gone", async () => {
    const hidden = await el("button[style]")
    expect(await lastingLocator(page, hidden, { role: "button", name: "Hidden thing" })).toEqual({
      error: expect.stringMatching(/isn't visible/) as unknown,
    })
    const save = await el("button")
    await page.evaluate(() => document.querySelector("button")?.remove())
    expect(await lastingLocator(page, save, { role: "button", name: "Save" })).toEqual({
      error: expect.stringMatching(/isn't on the page anymore/) as unknown,
    })
  })

  it("checks a hint against the page (a stale name never makes a locator for another element)", async () => {
    // The snapshot said "Save"; the element is now the Search field: no role locator for it.
    expect(await lasting("input", { role: "button", name: "Save" })).toEqual({
      locator: { by: "placeholder", text: "Search projects" },
    })
  })
})
