import { chromium, type Browser, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { type ElementHint, lastingLocator, namesARow } from "../src/index.ts"

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
    <ul class="todo"><li><span>Pay rent</span> <button>Remove</button></li>
      <li><span>Call mom</span> <button>Remove</button></li></ul>
    <table><tr><td>3</td><td>Pay rent</td><td>2 min ago</td><td><button>Drop</button></td></tr>
      <tr><td>4</td><td>Call mom</td><td>5 min ago</td><td><button>Drop</button></td></tr></table>
    <div class="pair"><button>Share</button><button>Share</button></div>
    <table class="status"><tr><td>Draft</td><td>Quarterly planning</td><td><button>Edit</button></td></tr>
      <tr><td>Live</td><td>Hiring pipeline</td><td><button>Edit</button></td></tr></table>
    <ul class="tips"><li><span hidden>Tip one</span><span>Alpha</span> <button>Open</button></li>
      <li><span hidden>Tip two</span><span>Beta</span> <button>Open</button></li></ul>
    <a href="#c" class="card-link"><h3>Card title</h3><p>Some description</p></a>
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

  it("tells a look-alike apart by its row: the text only that row holds", async () => {
    expect(
      await lasting(".todo li:nth-child(2) button", { role: "button", name: "Remove" }),
    ).toEqual({
      locator: { by: "role", role: "button", name: "Remove", exact: true },
      in: { role: "listitem", has: "Call mom" },
    })
    // Not where a step takes a locator alone (a condition), nor by a secret value.
    expect(
      await lastingLocator(
        page,
        await el(".todo li:nth-child(2) button"),
        { role: "button", name: "Remove" },
        any,
        { rows: false },
      ),
    ).toEqual(error(/here a locator can't name its row/))
    expect(
      await lasting(
        ".todo li:nth-child(2) button",
        { role: "button", name: "Remove" },
        (t) => t !== "Call mom",
      ),
    ).toEqual(error(/no row of it holds a name only that row holds/))
  })

  it("names a row by its name, never a row number or a time", async () => {
    expect(await lasting("tr:nth-child(2) button", { role: "button", name: "Drop" })).toEqual({
      locator: { by: "role", role: "button", name: "Drop", exact: true },
      in: { role: "row", has: "Call mom" },
    })
    const never = ["3", "#1042", "2 min ago", "10:42", "2026-10-03", "in 5 min", "5 minutes"]
    const alsoNever = ["Updated 3h", "Oct 3", "Mon", "12 items", "Order #1042", "just now"]
    // Review round 3's (each passed the earlier rule).
    const dates = ["October 3", "March 2026", "Monday", "Due Friday", "Sept 3", "Last week"]
    // On the safe side: a number with one word of its own isn't taken as a name either.
    const counts = ["5 mins", "12 stars", "Q4 Launch"]
    for (const text of [...never, ...alsoNever, ...dates, ...counts]) {
      expect(namesARow(text), text).toBe(false)
    }
    for (const text of ["Pay rent", "Call mom", "Q4 Launch plan", "Water plants"]) {
      expect(namesARow(text), text).toBe(true)
    }
  })

  it("names a row only by text that's shown (a hidden tooltip isn't there at replay)", async () => {
    expect(await lasting(".tips li:nth-child(2) button", { role: "button", name: "Open" })).toEqual(
      {
        locator: { by: "role", role: "button", name: "Open", exact: true },
        in: { role: "listitem", has: "Beta" },
      },
    )
  })

  it("names a row by its name before a status (the longest text first)", async () => {
    expect(
      await lasting(".status tr:nth-child(1) button", { role: "button", name: "Edit" }),
    ).toEqual({
      locator: { by: "role", role: "button", name: "Edit", exact: true },
      in: { role: "row", has: "Quarterly planning" },
    })
  })

  it("says when a look-alike sits in no row", async () => {
    expect(await lasting(".pair button:nth-child(2)", { role: "button", name: "Share" })).toEqual(
      error(/it sits in no row/),
    )
  })

  it("never gives a place among look-alikes (refused, said why)", async () => {
    expect(await lasting("li:nth-child(2) button", { role: "button", name: "Delete" })).toEqual(
      error(/several elements look just like it/),
    )
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
    expect(await lasting("#logo-box", { role: "generic" })).toEqual({
      locator: { by: "css", selector: "#logo-box" },
    })
    expect(await lasting("#r42", { role: "generic" })).toEqual(error(/no lasting locator/))
  })

  it("takes a role alone when it's the only one (no nth)", async () => {
    expect(await lasting("input[type=checkbox]", { role: "checkbox" })).toEqual({
      locator: { by: "role", role: "checkbox" },
    })
  })

  it("finds it by the page's text when the snapshot's reading of it doesn't", async () => {
    // The snapshot reads "Say hi" (hidden parts left out); getByText matches the DOM's text.
    expect(await lasting("ol li:nth-child(3)", { role: "listitem", text: "Say hi" })).toEqual({
      locator: { by: "text", text: "Say xhi", exact: true },
    })
  })

  it("names a link by its content when the snapshot left the name out (a card)", async () => {
    expect(await lasting(".card-link", { role: "link" })).toEqual({
      locator: { by: "role", role: "link", name: "Card title Some description", exact: true },
    })
  })

  it("never makes a field's value its locator (what was typed: a secret maybe)", async () => {
    await page.fill("input[placeholder]", "Q4 launch")
    expect(await lasting("input[placeholder]", { role: "textbox", text: "Q4 launch" })).toEqual({
      locator: { by: "placeholder", text: "Search projects" },
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
