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
    <div class="chip" style="text-transform:uppercase">Archive me</div>
    <div id="logo-box" style="width:40px;height:20px;background:#ccc"></div>
    <div id="r42" style="width:40px;height:20px;background:#ccc"></div>
    <button style="display:none">Hidden thing</button>
    <menu><button>Delete</button></menu>
    <section><button id="archive">Archive</button><button>Archive</button></section>
    <input type="checkbox">
    <ol><li>Buy milk</li><li>Item 12</li><li>Say <span style="display:none">x</span>hi</li></ol>`)
  return () => page.close()
})

const el = async (selector: string) => {
  const handle = await page.$(selector)
  if (handle === null) throw new Error(`no ${selector}`)
  return handle
}
const any = (_text: string) => true
const lasting = async (selector: string, hint: ElementHint, allowed = any) =>
  lastingLocator(page, await el(selector), hint, allowed)
const error = (pattern: RegExp) => ({ error: expect.stringMatching(pattern) as unknown })

describe("a lasting locator for an element the agent pointed at", () => {
  it("names it by role and name when that finds it alone", async () => {
    expect(await lasting("button", { role: "button", name: "Save" })).toEqual({
      locator: { by: "role", role: "button", name: "Save", exact: true },
    })
  })

  it("says its place among look-alikes (visible matches only), for the caller to place", async () => {
    expect(await lasting("li:nth-child(2) button", { role: "button", name: "Delete" })).toEqual({
      locator: { by: "role", role: "button", name: "Delete", exact: true },
      nth: 1,
    })
  })

  it("uses a field's placeholder, an element's own text (as the page has it, not as styled)", async () => {
    expect(await lasting("input", { role: "textbox" })).toEqual({
      locator: { by: "placeholder", text: "Search projects" },
    })
    expect(await lasting(".card", { role: "generic", text: "Open the Acme board" })).toEqual({
      locator: { by: "text", text: "Open the Acme board", exact: true },
    })
    // Shown uppercase, written as it is: getByText matches the page's text.
    expect(await lasting(".chip", { role: "generic", text: "Archive me" })).toEqual({
      locator: { by: "text", text: "Archive me", exact: true },
    })
  })

  it("prefers an id written by hand to a place among look-alikes; never a generated one", async () => {
    expect(await lasting("#archive", { role: "button", name: "Archive" })).toEqual({
      locator: { by: "css", selector: "#archive" },
    })
    // An element with no role or text of its own can't be checked against the snapshot.
    expect(await lasting("#logo-box", { role: "generic" })).toEqual(error(/no role or text/))
  })

  it("takes a role alone when it's the only one (no nth)", async () => {
    expect(await lasting("input[type=checkbox]", { role: "checkbox" })).toEqual({
      locator: { by: "role", role: "checkbox" },
    })
  })

  it("refuses an element that isn't what the snapshot said (a node reused with new content)", async () => {
    await page.evaluate(() => {
      document.querySelector("button")!.textContent = "Delete everything"
    })
    expect(await lasting("button", { role: "button", name: "Save" })).toEqual(
      error(/changed since the snapshot/),
    )
    expect(await lasting("input", { role: "button", name: "Save" })).toEqual(
      error(/changed since the snapshot/),
    )
  })

  it("checks a node's own text exactly (a reused list row with new text is another element)", async () => {
    // The row the snapshot saw as "Buy milk" now shows "Buy eggs": same role, same (no) name.
    await page.evaluate(() => {
      document.querySelector("ol li")!.textContent = "Buy eggs"
    })
    expect(await lasting("ol li", { role: "listitem", text: "Buy milk" })).toEqual(
      error(/changed since the snapshot/),
    )
    expect(await lasting("ol li:nth-child(2)", { role: "listitem", text: "Item 1" })).toEqual(
      error(/changed since the snapshot/),
    )
    // Its text as the snapshot reads it (hidden parts left out) is the same element; the locator is
    // the one that finds it: getByText matches the DOM's text, hidden parts included.
    expect(await lasting("ol li:nth-child(3)", { role: "listitem", text: "Say hi" })).toEqual({
      locator: { by: "text", text: "Say xhi", exact: true },
    })
  })

  it("never puts a secret value in a locator", async () => {
    const noSave = (text: string) => !text.includes("Save")
    expect(await lasting("button", { role: "button", name: "Save" }, noSave)).toEqual(
      error(/its names hold a secret value/),
    )
  })

  it("refuses an element that's hidden, gone, or of another page than the step's", async () => {
    expect(await lasting("button[style]", { role: "button", name: "Hidden thing" })).toEqual(
      error(/isn't visible/),
    )
    const other = await browser.newPage()
    try {
      expect(
        await lastingLocator(other, await el("button"), { role: "button", name: "Save" }, any),
      ).toEqual(error(/on another page than the one the step runs on/))
    } finally {
      await other.close()
    }
    const save = await el("button")
    await page.evaluate(() => document.querySelector("button")?.remove())
    expect(await lastingLocator(page, save, { role: "button", name: "Save" }, any)).toEqual(
      error(/isn't on the page anymore/),
    )
  })
})
