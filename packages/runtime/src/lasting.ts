// A lasting locator for an element the agent picked on the live page (a snapshot's ref): the first
// one, in the order the agent is told to prefer (role and name, placeholder, text, then `nth`, then
// a stable id), that finds exactly that element among the visible ones, through the very rules a
// replay resolves with (`locatorFor`: the exact-names rule of secrets, the css checks).
import type { Locator as SchemaLocator } from "@kiframe/schema"
import type { ElementHandle, Page } from "playwright"
import { locatorFor, visibleOnly } from "./targets.ts"

/** What the snapshot said of the element (its role and accessible name), when it said it. */
export interface ElementHint {
  role: string
  name?: string | undefined
}

/** A locator (and `nth` among its visible matches) that finds the element, or why there's none. */
export type Lasting = { locator: SchemaLocator; nth?: number } | { error: string }

/** Roles a role locator can't usefully name (Playwright matches none of them by role). */
const NO_ROLE_LOCATOR = new Set(["generic", "none", "presentation", "text", "paragraph"])

/** The longest visible text used as a text locator (longer is a paragraph, never a lasting one). */
const TEXT_MAX = 80

export async function lastingLocator(
  page: Page,
  element: ElementHandle<Element>,
  hint: ElementHint | undefined,
): Promise<Lasting> {
  const facts = await element
    .evaluate((el) => {
      const own = el instanceof HTMLElement ? el.innerText.trim() : ""
      const placeholder = el.getAttribute("placeholder")?.trim() ?? ""
      return { connected: el.isConnected, text: own, placeholder, id: el.id }
    })
    .catch(() => undefined)
  if (facts?.connected !== true)
    return { error: "it isn't on the page anymore: take a new snapshot" }
  if (!(await element.isVisible())) {
    return {
      error: "it isn't visible: open what shows it first (a menu, a panel), then a snapshot",
    }
  }

  const named: SchemaLocator[] = []
  const role = hint !== undefined && !NO_ROLE_LOCATOR.has(hint.role) ? hint.role : undefined
  if (role !== undefined && /^[a-z]{2,40}$/.test(role) && hint?.name) {
    named.push({ by: "role", role, name: hint.name, exact: true })
  }
  if (facts.placeholder !== "") named.push({ by: "placeholder", text: facts.placeholder })
  const text =
    facts.text !== "" && facts.text.length <= TEXT_MAX && !facts.text.includes("\n")
      ? facts.text
      : undefined
  if (text !== undefined) named.push({ by: "text", text, exact: true })

  // Exactly that element, alone.
  for (const locator of named) {
    const at = await indexAmongVisible(page, locator, element)
    if (at?.index === 0 && at.count === 1) return { locator }
  }
  // Several look alike: the same, with its place among them.
  const nthOf: SchemaLocator[] = [...named]
  if (role !== undefined && /^[a-z]{2,40}$/.test(role) && !hint?.name) {
    nthOf.push({ by: "role", role })
  }
  for (const locator of nthOf) {
    const at = await indexAmongVisible(page, locator, element)
    if (at !== undefined && at.index >= 0) return { locator, nth: at.index }
  }
  // Last resort: an id that reads as written by hand (no digits: generated ids change per load).
  if (/^[A-Za-z][A-Za-z_-]*$/.test(facts.id)) {
    const locator: SchemaLocator = { by: "css", selector: `#${facts.id}` }
    const at = await indexAmongVisible(page, locator, element)
    if (at?.index === 0 && at.count === 1) return { locator }
  }
  return {
    error:
      "no lasting locator finds it (no role and name, placeholder, text or stable id): write one from the snapshot",
  }
}

/** Where the element is among a locator's visible matches (-1: not among them), and how many. */
async function indexAmongVisible(
  page: Page,
  locator: SchemaLocator,
  element: ElementHandle<Element>,
): Promise<{ index: number; count: number } | undefined> {
  try {
    const matches = visibleOnly(await locatorFor(page, locator))
    return await matches.evaluateAll(
      (els, target) => ({ index: (els as Element[]).indexOf(target), count: els.length }),
      element,
    )
  } catch {
    // A locator the rules refuse (a css probing a secret field): not this one.
    return undefined
  }
}
