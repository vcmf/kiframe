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
    "input[name=password i]",
    "ul li + li ~ li",
    "button:focus",
    // Common hide rules: descendants, a banner's container, an escaped utility class.
    "#intercom-container *",
    "div:has(> .cookie-banner)",
    "div:has(input)",
    ".md\\:hidden",
    "*",
    // Whole-value tests on text attributes; any operator on identity ones.
    'a[href="/login"]',
    "img[alt~=avatar]",
    "[aria-expanded=true]",
    "[data-testid=row-1]",
    "div[contenteditable='true']",
  ])("accepts %s", (selector) => expect(isSafeSelector(selector)).toBe(true))

  it.each([
    // The value attribute, however it's spelled.
    "input[value^='h']",
    "input[ value ]",
    "input[VALUE*=x]",
    "input[data-value=1]",
    "input[ng-reflect-model^=h]",
    // Prefix or substring tests on attributes that hold the user's name or email.
    "img[alt^='b']",
    "a[href^='mailto:b']",
    "[aria-label*='acme']",
    "[title$=com]",
    "[placeholder|=bob]",
    "form[action*='bob']",
    // Partial operators on identity attributes too (a displayed slug, `:has()` from elsewhere).
    "[data-testid^='avatar-b']",
    "ul:not(:has([data-testid*=bob]))",
    "input[name^=pass]",
    // Text-bearing ARIA attributes aren't states: refused.
    "[aria-braillelabel^='b']",
    "[aria-rowindextext^=b]",
    "[aria-keyshortcuts^=b]",
    "input[aria-valuetext=x]",
    "form:has(input[value^='h']) button",
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
    "input:visible",
    "a\\:b",
    "[\\76 alue]",
    "input[type=password",
    "",
  ])("refuses %s", (selector) => expect(isSafeSelector(selector)).toBe(false))
})
