import { type Browser, chromium, type Page } from "playwright"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import {
  formValues,
  type FormValue,
  scrubSecrets,
  typedValues,
  valuePattern,
} from "../src/index.ts"

// What a user typed during a handover, from what the page's fields hold.

let browser: Browser
let page: Page
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
})
beforeEach(async () => {
  page = await browser.newPage()
  return () => page.close()
})

const field = (key: string, value: string, order = 0, doc = "d"): FormValue => ({
  key,
  value,
  order,
  doc,
})

describe("typedValues", () => {
  it("keeps a field's value as the page shows it (reformatted), never one the page filled in itself", () => {
    const before = [field("card", ""), field("name", "")]
    const after = [field("card", "4242 4242 4242 4242", 0), field("name", "Jane Doe", 1)]
    expect(typedValues(before, after, "4242424242424242")).toEqual(["4242 4242 4242 4242"])
  })

  it("joins a code typed one digit per box; keeps a 3-digit CVV, never 3 letters", () => {
    const boxes = [1, 2, 3, 4, 5, 6].map((n) => field(`b${n}`, "778899"[n - 1]!, n))
    const after = [...boxes, field("cvv", "123", 9), field("nick", "Bob", 10)]
    expect(new Set(typedValues([], after, "778899123Bob"))).toEqual(new Set(["778899", "123"]))
  })
})

describe("formValues", () => {
  it("reads text fields (inputs, a textarea, a frame's, a closed shadow root's), never a password's", async () => {
    await page.setContent(`
      <input id="a" value="alpha-1"><textarea id="t">tango-2</textarea>
      <input type="password" value="pw-secret-3"><input type="checkbox" value="box-4">
      <input type="cc" value="card-7">
      <iframe srcdoc="<input value='frame-5'>"></iframe><div id="host"></div>`)
    await page.evaluate(() => {
      const root = document.getElementById("host")!.attachShadow({ mode: "closed" })
      root.innerHTML = `<input value="shadow-6">`
    })
    await page.frames()[1]?.waitForLoadState()
    const values = await formValues(page.context())
    expect(values.map((v) => v.value).sort()).toEqual(
      ["alpha-1", "card-7", "frame-5", "shadow-6", "tango-2"].sort(),
    )
  })
})

describe("a number however it's written", () => {
  it("is scrubbed with any separators between its digits, and only a number is", () => {
    expect(scrubSecrets("card 4242 4242 4242 4242 ok", ["4242424242424242"])).toBe(
      "card [secret] ok",
    )
    expect(scrubSecrets("x 4242-4242-4242-4242", ["4242 4242 4242 4242"])).toBe("x [secret]")
    expect(scrubSecrets("Main St 12 and 1 2", ["Main St 12"])).toBe("[secret] and 1 2")
    // A phone number: as written (its parentheses and +), and with other separators.
    const phone = "+1 (555) 123-4567"
    expect(valuePattern(phone).test(phone)).toBe(true)
    expect(valuePattern(phone).test("1 555 123 4567")).toBe(true)
    expect(scrubSecrets(`call ${phone} now`, [phone])).toBe("call [secret] now")
    // As written still: a long number glued to other digits (a recording's blur matches it).
    expect(valuePattern("12345678").test("ID 9912345678")).toBe(true)
  })
})
