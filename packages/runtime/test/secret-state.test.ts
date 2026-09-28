import { describe, expect, it } from "vitest"
import { isSafeSelector } from "../src/secret-state.ts"

// SECRETS-DESIGN §3 A8: the CSS subset accepted while a secret is known (an allowlist).
describe("isSafeSelector", () => {
  it.each([
    "input[type=password]",
    ".password-field",
    "#email",
    "form > input:nth-child(2)",
    "li:nth-of-type(odd)",
    "input:not(.hidden):not([disabled])",
    "button.primary, a.link",
    '[data-testid="save"]',
    "[aria-label='Close']",
    "input[name^=pass i]",
    "ul li + li ~ li",
    "button:focus",
  ])("accepts %s", (selector) => expect(isSafeSelector(selector)).toBe(true))

  it.each([
    // The value attribute, however it's spelled.
    "input[value^='h']",
    "input[ value ]",
    "input[VALUE*=x]",
    "input[data-value=1]",
    'input[\\76 alue^="hun"]',
    "input[*|value]",
    "input[|value]",
    // Playwright's other engines and XPath.
    "(//input)",
    "xpath =//input",
    "xpath=//input",
    "//input",
    "*xpath=//x",
    "_react=Comp",
    "text=Hi",
    "form >> input",
    // Playwright's CSS extensions and anything outside the subset.
    'div:has-text("x")',
    "div:has(input)",
    "input:visible",
    "*",
    "a\\:b",
    "input[type=password",
    "",
  ])("refuses %s", (selector) => expect(isSafeSelector(selector)).toBe(false))
})
