// A lasting locator for an element the agent picked on the live page (a snapshot's ref): the first
// candidate, in the order the agent is told to prefer (role and name, placeholder, text, an id
// written by hand, a role alone), that finds exactly that element and nothing else among the
// visible ones, through the rules a replay resolves with. Never a place among look-alikes (`nth`):
// Playwright's own advice ("may click on an element you did not intend" once the page changes);
// a look-alike is refused, said why.
import type { Locator as SchemaLocator } from "@kiframe/schema"
import type { ElementHandle, Page } from "playwright"
import { exactNamesFor } from "./secret-state.ts"
import { toPlaywright, visibleOnly } from "./targets.ts"

/** What the snapshot said of the element: its role, accessible name, and its own text if any. */
export interface ElementHint {
  role: string
  name?: string | undefined
  text?: string | undefined
}

/** A locator that finds the element alone, or why there's none. */
export type Lasting = { locator: SchemaLocator } | { error: string }

/** Roles a role locator can't usefully name (Playwright matches none of them by role). */
const NO_ROLE_LOCATOR = new Set(["generic", "none", "presentation", "text", "paragraph"])

/** Roles whose snapshot text is a value (what's typed or picked), never what the element is. */
export const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"])

/** The longest visible text used as a text locator (longer is a paragraph, never a lasting one). */
const TEXT_MAX = 80

/** Text as a snapshot and a text locator compare it: whitespace collapsed (one helper for both). */
export const collapse = (text: string) => text.replace(/\s+/g, " ").trim()

export async function lastingLocator(
  page: Page,
  element: ElementHandle<Element>,
  hint: ElementHint,
  /** Whether a string may go into the locator (a secret value never does: the studio's scrubber). */
  allowed: (text: string) => boolean,
): Promise<Lasting> {
  const frame = await element.ownerFrame().catch(() => null)
  const facts =
    frame === null
      ? undefined
      : await element
          .evaluate((el) => ({
            connected: el.isConnected,
            text: el.textContent ?? "",
            // Blocks apart ("Card title Some description", where textContent runs them together).
            shown: el instanceof HTMLElement ? el.innerText : "",
            placeholder: el.getAttribute("placeholder") ?? "",
            id: el.id,
          }))
          .catch(() => undefined)
  if (facts?.connected !== true) {
    return { error: "it isn't on the page anymore (the page changed): take a new snapshot" }
  }
  if (frame?.page() !== page) {
    return {
      error:
        "it's on another page than the one the step runs on (a step before opened or closed one): take a new snapshot",
    }
  }
  if (!(await element.isVisible().catch(() => false))) {
    return {
      error: "it isn't visible: open what shows it first (a menu, a panel), then a snapshot",
    }
  }

  // That it's still the element the snapshot showed is the caller's to check (in Playwright's own
  // model: a fresh snapshot of the same document); here, the locator that finds it.
  const role =
    !NO_ROLE_LOCATOR.has(hint.role) && /^[a-z]{2,40}$/.test(hint.role) ? hint.role : undefined
  const text = collapse(facts.text)
  const candidates: SchemaLocator[] = []
  if (role !== undefined && hint.name) {
    candidates.push({ by: "role", role, name: hint.name, exact: true })
  }
  // A name the snapshot left out (Playwright drops one made of the element's content: a card's
  // link): its content as shown, checked like any candidate.
  // Never a field's (its content is its value: what's typed or picked).
  const shown = collapse(facts.shown)
  if (
    role !== undefined &&
    !hint.name &&
    !VALUE_ROLES.has(role) &&
    shown !== "" &&
    shown.length <= TEXT_MAX
  ) {
    candidates.push({ by: "role", role, name: shown, exact: true })
  }
  const placeholder = facts.placeholder.trim()
  if (placeholder !== "") candidates.push({ by: "placeholder", text: placeholder })
  // Its text as the snapshot said it (Playwright's own reading), then as the DOM has it; never a
  // field's (its text is its value: what was typed, a secret maybe, and no text locator finds it).
  if (!VALUE_ROLES.has(hint.role)) {
    for (const t of new Set([collapse(hint.text ?? ""), text])) {
      if (t !== "" && t.length <= TEXT_MAX) candidates.push({ by: "text", text: t, exact: true })
    }
  }
  // An id that reads as written by hand (no digits: generated ids change per load).
  if (/^[A-Za-z][A-Za-z_-]*$/.test(facts.id)) {
    candidates.push({ by: "css", selector: `#${facts.id}` })
  }
  if (role !== undefined && !hint.name) candidates.push({ by: "role", role })
  // No secret value in a locator: it would be shown redacted, and the replay would look for that.
  const usable = candidates.filter((c) => stringsOf(c).every(allowed))
  if (candidates.length > 0 && usable.length === 0) {
    return { error: "its names hold a secret value: write a locator without it" }
  }

  // The secrets' exact-names rule as the page has it now, and as a fresh replay may have it (off,
  // before any secret is typed): a candidate counts only if both find the same.
  const { exact } = await exactNamesFor(page, usable)
  const counted = await Promise.all(
    usable.map(async (locator) => {
      const now = await indexAmong(page, locator, element, exact)
      const fresh = exact ? await indexAmong(page, locator, element, false) : now
      const agree =
        now !== undefined &&
        fresh !== undefined &&
        now.index === fresh.index &&
        now.count === fresh.count
      return agree ? { locator, ...now } : undefined
    }),
  )
  const found = counted.filter(
    (c): c is { locator: SchemaLocator; index: number; count: number } =>
      c !== undefined && c.index >= 0,
  )
  const alone = found.find((c) => c.count === 1)
  if (alone !== undefined) return { locator: alone.locator }
  if (found.length > 0) {
    return {
      error:
        "several elements look just like it (no locator finds it alone): write its locator by hand from the snapshot",
    }
  }
  return {
    error:
      "no lasting locator finds it (no role and name, placeholder, text or stable id): write one from the snapshot",
  }
}

/** Every string a locator would carry. */
function stringsOf(locator: SchemaLocator): string[] {
  switch (locator.by) {
    case "role":
      return [locator.role, locator.name ?? ""]
    case "label":
      return [locator.name]
    case "text":
    case "placeholder":
      return [locator.text]
    case "css":
      return [locator.selector]
  }
}

/**
 * Where the element is among a locator's visible matches (as a replay counts them, and `nth`; -1:
 * not among them), and how many; undefined: a locator the rules refuse.
 */
async function indexAmong(
  page: Page,
  locator: SchemaLocator,
  element: ElementHandle<Element>,
  exact: boolean,
): Promise<{ index: number; count: number } | undefined> {
  try {
    return await visibleOnly(toPlaywright(page, locator, exact)).evaluateAll(
      (els, target) => ({ index: (els as Element[]).indexOf(target), count: els.length }),
      element,
    )
  } catch (error) {
    // The page moving under it (a navigation finishing, the page closing) is no locator's fault:
    // said by the caller ("the page changed").
    if (isPageGone(error)) throw error
    // A locator the rules refuse (a css probing a secret field): not this one.
    return undefined
  }
}

/** An error that says the page or its document went away (never a locator's own fault). */
function isPageGone(error: unknown): boolean {
  return /Execution context was destroyed|Target page, context or browser has been closed|frame was detached/i.test(
    error instanceof Error ? error.message : String(error),
  )
}
