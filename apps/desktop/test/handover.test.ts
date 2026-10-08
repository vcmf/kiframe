import { type Browser, chromium, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { formValues } from "@kiframe/runtime"
import { Handover } from "../src/main/handover.ts"

// The user's hands on the agent's browser during a handover: points as fractions of the page,
// keys by name, text as text; nothing once it's closed; whatever is held released at the end.

let browser: Browser
let page: Page
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
})
beforeEach(async () => {
  page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.setContent(`
    <button id="b" style="position:absolute;left:400px;top:300px;width:100px;height:40px"
      onclick="this.textContent='clicked'">go</button>
    <input id="i" style="position:absolute;left:0;top:0;width:300px">
    <script>window.keys = []
      addEventListener("keydown", (e) => keys.push("down:" + e.key))
      addEventListener("keyup", (e) => keys.push("up:" + e.key))
      addEventListener("mouseup", () => keys.push("mouseup"))</script>`)
  return () => page.close()
})

/** The page's text fields (as the host reads them). */
const read = () => formValues(page.context())

/** Every event queued so far applied (a handover's input is applied in order, one at a time). */
const settled = () => new Promise((r) => setTimeout(r, 300))

describe("a handover's input", () => {
  it("clicks where the user clicked on the frame (fractions of the page)", async () => {
    const h = new Handover("h1", () => page, read)
    // The button's middle: (450, 320) of 800×600.
    const at = { x: 450 / 800, y: 320 / 600 }
    h.input({ kind: "mouse", type: "down", ...at, button: "left", clickCount: 1 })
    h.input({ kind: "mouse", type: "up", ...at, button: "left", clickCount: 1 })
    await settled()
    expect(await page.textContent("#b")).toBe("clicked")
  })

  it("types text, sends keys by name, never a copy/paste shortcut, and nothing once closed", async () => {
    const h = new Handover("h1", () => page, read)
    await page.click("#i")
    h.input({ kind: "text", text: "bob@acme" })
    h.input({ kind: "key", key: "Backspace", modifiers: [] })
    h.input({ kind: "key", key: "v", modifiers: ["Meta"] })
    await settled()
    expect(await page.inputValue("#i")).toBe("bob@acm")
    expect(await page.evaluate(() => (window as unknown as { keys: string[] }).keys)).not.toContain(
      "down:v",
    )
    await h.close()
    h.input({ kind: "text", text: "more" })
    await settled()
    expect(await page.inputValue("#i")).toBe("bob@acm")
  })

  it("types a keystroke's text as keys (the page sees it pressed), a longer text inserted whole", async () => {
    const h = new Handover("h1", () => page, read)
    await page.click("#i")
    h.input({ kind: "text", text: "x" })
    h.input({ kind: "text", text: "pasted text" })
    await settled()
    const keys = await page.evaluate(() => (window as unknown as { keys: string[] }).keys)
    expect(keys).toContain("down:x")
    expect(keys).not.toContain("down:p")
    expect(await page.inputValue("#i")).toBe("xpasted text")
  })

  it("lets a release through even when the queue is full (a button never stays held)", async () => {
    const h = new Handover("h1", () => page, read)
    h.input({ kind: "mouse", type: "down", x: 0.1, y: 0.5, button: "left", clickCount: 1 })
    for (let i = 0; i < 600; i++) {
      h.input({
        kind: "mouse",
        type: "move",
        x: (i % 9) / 10,
        y: 0.5,
        button: "left",
        clickCount: 0,
      })
    }
    h.input({ kind: "mouse", type: "up", x: 0.1, y: 0.5, button: "left", clickCount: 1 })
    // Applied in turn, before any end (which would release it anyway).
    await page.waitForFunction(
      () => (window as unknown as { keys: string[] }).keys.includes("mouseup"),
      undefined,
      { timeout: 15_000 },
    )
  }, 30_000)

  it("gives what the page's fields hold: a code across boxes joined, a card as the page formats it, never what the page filled in", async () => {
    await page.setContent(`
      ${[0, 1, 2, 3, 4, 5].map((i) => `<input class="d" maxlength="1" data-i="${i}">`).join("")}
      <input id="card"><input id="name">
      <script>
        document.querySelectorAll(".d").forEach((box, i, all) =>
          box.addEventListener("input", () => all[i + 1]?.focus()))
        const card = document.getElementById("card")
        card.addEventListener("input", () => {
          card.value = card.value.replace(/\\D/g, "").replace(/(\\d{4})(?=\\d)/g, "$1 ")
        })
        setTimeout(() => { document.getElementById("name").value = "Jane Doe" }, 200)
      </script>`)
    const h = new Handover("h1", () => page, read)
    await page.click(".d")
    for (const digit of "778899") h.input({ kind: "text", text: digit })
    await settled()
    await page.click("#card")
    for (const digit of "4242424242424242") h.input({ kind: "text", text: digit })
    const typed = await h.close()
    expect(typed).toContain("778899")
    expect(typed).toContain("4242 4242 4242 4242")
    expect(typed).not.toContain("Jane Doe")
  })

  it("presses a key with its modifiers once (nothing stays held), and gives what the user typed", async () => {
    const h = new Handover("h1", () => page, read)
    await page.click("#i")
    h.input({ kind: "text", text: "code 4821" })
    h.input({ kind: "key", key: "Enter", modifiers: [] })
    h.input({ kind: "text", text: "ab" })
    h.input({ kind: "key", key: "ArrowLeft", modifiers: ["Shift"] })
    const typed = await h.close()
    // The field as it ends (the keys after Enter typed into it too), the runs and their words.
    expect(new Set(typed)).toEqual(new Set(["code 4821ab", "code 4821", "code", "4821"]))
    const keys = await page.evaluate(() => (window as unknown as { keys: string[] }).keys)
    expect(keys.slice(-2)).toEqual(["up:ArrowLeft", "up:Shift"])
  })
})
