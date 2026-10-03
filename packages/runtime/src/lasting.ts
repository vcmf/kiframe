// A lasting locator for an element the agent picked on the live page (a snapshot's ref): the first
// candidate, in the order the agent is told to prefer (role and name, placeholder, text, an id
// written by hand, a role alone), that finds exactly that element and nothing else among the
// visible ones, through the rules a replay resolves with. A look-alike (each row's "Delete") is
// told apart by its row (`in`: the row holding a text only it holds), Playwright's own advice;
// never by a place among look-alikes (`nth`), which a changed page turns into another element.
import type { Locator as SchemaLocator, Scope } from "@kiframe/schema"
import type { ElementHandle, Page } from "playwright"
import { exactNamesFor } from "./secret-state.ts"
import { rowOf, toPlaywright, visibleOnly } from "./targets.ts"

/** What the snapshot said of the element: its role, accessible name, and its own text if any. */
export interface ElementHint {
  role: string
  name?: string | undefined
  text?: string | undefined
}

/** A locator that finds the element alone (in its row, for a look-alike), or why there's none. */
export type Lasting = { locator: SchemaLocator; in?: Scope } | { error: string }

/** Roles of rows a look-alike is told apart by (the nearest one holding it). */
const ROW_ROLES = ["listitem", "row", "article", "option", "treeitem"] as const

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
  /** Whether a row (`in`) may tell a look-alike apart (where the step takes a target). */
  options: { rows: boolean } = { rows: true },
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
  // Inside an iframe (one the snapshot gave no ref of its own): a step's locators reach the page's
  // own elements only.
  if (frame !== null && frame.page() === page && frame !== page.mainFrame()) {
    return { error: "it's inside a frame (an iframe): steps reach the page's own elements only" }
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
  // In order, the first that finds it alone (and whether any found it among look-alikes).
  let lookAlike = false
  for (const locator of usable) {
    const now = await indexAmong(page, locator, element, exact)
    const fresh = exact ? await indexAmong(page, locator, element, false) : now
    if (now === undefined || fresh === undefined || now.index < 0) continue
    if (now.count === 1 && fresh.count === 1 && fresh.index === 0) return { locator }
    lookAlike = true
  }
  if (lookAlike) {
    if (!options.rows) {
      return {
        error:
          "several elements look just like it (here a locator can't name its row): point at a unique element, or write its locator by hand",
      }
    }
    const inRow = await inItsRow(page, element, usable, allowed, exact)
    if (inRow.found !== undefined) return inRow.found
    return {
      error: inRow.row
        ? "several elements look just like it, and no row of it holds a name only that row holds: write its locator by hand from the snapshot"
        : "several elements look just like it, and it sits in no row (a list item, a table row…): write its locator by hand from the snapshot",
    }
  }
  return {
    error:
      "no lasting locator finds it (no role and name, placeholder, text or stable id): write one from the snapshot",
  }
}

/**
 * Whether a text names a row (a title: "Pay rent"), never a position or a passing value: a row
 * number ("3"), an id ("#1042"), a time ("2 min ago", "10:42"), a date ("2026-10-03").
 */
export function namesARow(text: string): boolean {
  if (!/\p{L}{2}/u.test(text)) return false // no word: a number, an id, a symbol
  if (/\b(ago|just now|today|yesterday|tomorrow)\b/i.test(text)) return false
  if (/\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}/.test(text)) return false
  return true
}

/**
 * A look-alike told apart by its row: the nearest row-like element holding it (a list item, a table
 * row…, whichever role is nearest), a name-like text in that row only that row holds (exactly; never
 * a field's value nor a secret; a heading's or a link's first), and a candidate that finds the
 * element alone in it. Undefined `row`: it sits in no row at all.
 */
async function inItsRow(
  page: Page,
  element: ElementHandle<Element>,
  usable: SchemaLocator[],
  allowed: (text: string) => boolean,
  exact: boolean,
): Promise<{ found: { locator: SchemaLocator; in: Scope } | undefined; row: boolean }> {
  // The nearest row of each role holding the element (its depth), and its texts, titles first.
  const nearest = await Promise.all(
    ROW_ROLES.map((role) =>
      page
        .getByRole(role)
        .evaluateAll((rows, target) => {
          const holding = (rows as Element[]).filter((r) => r.contains(target))
          const row = holding.find((r) => !holding.some((o) => o !== r && r.contains(o)))
          if (row === undefined) return undefined
          let depth = 0
          for (let e: Element | null = row; e !== null; e = e.parentElement) depth += 1
          // Inside the row (a row's `has` is an element in it, never the row itself).
          const leaves = [...row.querySelectorAll("*")].filter(
            (e) =>
              !["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE"].includes(e.tagName) &&
              !e.contains(target) &&
              !target.contains(e) &&
              [...e.childNodes].some(
                (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
              ),
          )
          const title = (e: Element) =>
            e.closest("h1,h2,h3,h4,h5,h6,a,strong,b,[role=heading],[role=link]") !== null
          const texts = [...leaves.filter(title), ...leaves.filter((e) => !title(e))].map((e) =>
            (e.textContent ?? "").replace(/\s+/g, " ").trim(),
          )
          return { depth, texts }
        }, element)
        .then((r) => (r === undefined ? undefined : { role, ...r }))
        .catch((error: unknown) => {
          if (isPageGone(error)) throw error
          return undefined
        }),
    ),
  )
  const rows = nearest
    .filter((r): r is NonNullable<typeof r> => r !== undefined)
    .sort((a, b) => b.depth - a.depth)
  for (const { role, texts } of rows) {
    for (const has of new Set(texts)) {
      if (has === "" || has.length > TEXT_MAX || !allowed(has) || !namesARow(has)) continue
      const scope: Scope = { role, has }
      const found = await rowOf(page, scope)
      if (!("row" in found)) continue
      const row = found.row
      const holds = await row
        .evaluate((r, target) => r.contains(target), element)
        .catch(() => false)
      if (!holds) continue
      // The element alone in its row, under both exact-names rules (as a replay may have them).
      for (const locator of usable) {
        const now = await indexAmong(page, locator, element, exact, row)
        const fresh = exact ? await indexAmong(page, locator, element, false, row) : now
        if (now?.count === 1 && now.index === 0 && fresh?.count === 1 && fresh.index === 0) {
          return { found: { locator, in: scope }, row: true }
        }
      }
    }
  }
  return { found: undefined, row: rows.length > 0 }
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
  within?: Parameters<typeof toPlaywright>[3],
): Promise<{ index: number; count: number } | undefined> {
  try {
    return await visibleOnly(toPlaywright(page, locator, exact, within)).evaluateAll(
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
export function isPageGone(error: unknown): boolean {
  return /Execution context was destroyed|Target page, context or browser has been closed|frame was detached/i.test(
    error instanceof Error ? error.message : String(error),
  )
}
