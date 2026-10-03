// A lasting locator for an element the agent picked on the live page (a snapshot's ref): the first
// one, in the order the agent is told to prefer (role and name, placeholder, text, then an id written
// by hand; only then a place among look-alikes, `nth`), that finds exactly that element among the
// visible ones, through the very rules a replay resolves with (the exact-names rule of secrets, the
// css checks).
import type { Locator as SchemaLocator } from "@kiframe/schema"
import type { ElementHandle, Page } from "playwright"
import { exactNamesFor } from "./secret-state.ts"
import { toPlaywright, visibleOnly } from "./targets.ts"

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
  options: { nth: boolean } = { nth: true },
): Promise<Lasting> {
  // The page the step runs on: a handle of another one (a step before opened or closed a page)
  // can't be checked there.
  if ((await element.ownerFrame().catch(() => null))?.page() !== page) {
    return {
      error:
        "it's on another page than the one the step runs on (a step before opened or closed one): take a new snapshot",
    }
  }
  const facts = await element
    .evaluate((el) => {
      const own = el instanceof HTMLElement ? el.innerText.trim() : ""
      const placeholder = el.getAttribute("placeholder")?.trim() ?? ""
      return { connected: el.isConnected, text: own, placeholder, id: el.id }
    })
    .catch(() => undefined)
  if (facts?.connected !== true) {
    return { error: "it isn't on the page anymore: take a new snapshot" }
  }
  if (!(await element.isVisible())) {
    return {
      error: "it isn't visible: open what shows it first (a menu, a panel), then a snapshot",
    }
  }

  // A role a role locator can name (the schema's own rule: lowercase letters).
  const role =
    hint !== undefined && !NO_ROLE_LOCATOR.has(hint.role) && /^[a-z]{2,40}$/.test(hint.role)
      ? hint.role
      : undefined
  const named: SchemaLocator[] = []
  if (role !== undefined && hint?.name)
    named.push({ by: "role", role, name: hint.name, exact: true })
  if (facts.placeholder !== "") named.push({ by: "placeholder", text: facts.placeholder })
  const text =
    facts.text !== "" && facts.text.length <= TEXT_MAX && !facts.text.includes("\n")
      ? facts.text
      : undefined
  if (text !== undefined) named.push({ by: "text", text, exact: true })
  // An id that reads as written by hand (no digits: generated ids change per load).
  const id: SchemaLocator[] = /^[A-Za-z][A-Za-z_-]*$/.test(facts.id)
    ? [{ by: "css", selector: `#${facts.id}` }]
    : []
  const nthOf: SchemaLocator[] = [
    ...named,
    ...(role !== undefined && !hint?.name ? [{ by: "role" as const, role }] : []),
  ]

  // The secrets' exact-names rule, decided once for every candidate (as a replay decides it).
  const { exact } = await exactNamesFor(page, [...named, ...id, ...nthOf])
  const where = (locator: SchemaLocator) => indexAmongVisible(page, locator, element, exact)
  // Exactly that element, alone: by what it says, then by a stable id.
  for (const locator of [...named, ...id]) {
    const at = await where(locator)
    if (at?.index === 0 && at.count === 1) return { locator }
  }
  // Several look alike: the same, with its place among them (only where a step takes `nth`).
  if (options.nth) {
    for (const locator of nthOf) {
      const at = await where(locator)
      if (at !== undefined && at.index >= 0) return { locator, nth: at.index }
    }
  }
  return {
    error: options.nth
      ? "no lasting locator finds it (no role and name, placeholder, text or stable id): write one from the snapshot"
      : "no locator finds it alone (here a locator can't say which of several look-alikes): point at a unique element, or write one from the snapshot",
  }
}

/** Where the element is among a locator's visible matches (-1: not among them), and how many. */
async function indexAmongVisible(
  page: Page,
  locator: SchemaLocator,
  element: ElementHandle<Element>,
  exact: boolean,
): Promise<{ index: number; count: number } | undefined> {
  try {
    const matches = visibleOnly(toPlaywright(page, locator, exact))
    return await matches.evaluateAll(
      (els, target) => ({ index: (els as Element[]).indexOf(target), count: els.length }),
      element,
    )
  } catch {
    // A locator the rules refuse (a css probing a secret field): not this one.
    return undefined
  }
}
