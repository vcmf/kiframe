// A lasting locator for an element the agent picked on the live page (a snapshot's ref). First the
// element must still be what the snapshot said (a reused node with new content is another element),
// then the first candidate, in the order the agent is told to prefer (role and name, placeholder,
// text, an id written by hand, a role alone), that finds exactly that element among the visible
// ones, through the rules a replay resolves with; else, among look-alikes, the candidate with the
// fewest, and the element's place among them (`nth`: where the step's schema takes one).
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

/** Alone; or a place among look-alikes (the caller decides whether `nth` can go there); or why not. */
export type Lasting =
  | { locator: SchemaLocator; nth?: undefined }
  | { locator: SchemaLocator; nth: number }
  | { error: string }

/** Roles a role locator can't usefully name (Playwright matches none of them by role). */
const NO_ROLE_LOCATOR = new Set(["generic", "none", "presentation", "text", "paragraph"])

/** The longest visible text used as a text locator (longer is a paragraph, never a lasting one). */
const TEXT_MAX = 80

const collapse = (text: string) => text.replace(/\s+/g, " ").trim()

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
            shown: el instanceof HTMLElement ? el.innerText : (el.textContent ?? ""),
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

  // Still what the snapshot said: its role (and name), and its own text when the snapshot gave it
  // (the page's text, whitespace collapsed, hidden parts left out: compared with what's shown and
  // with the DOM's, case aside, exactly: "Item 12" isn't "Item 1").
  const role =
    !NO_ROLE_LOCATOR.has(hint.role) && /^[a-z]{2,40}$/.test(hint.role) ? hint.role : undefined
  const text = collapse(facts.text)
  const said: SchemaLocator | undefined =
    role === undefined
      ? undefined
      : { by: "role", role, ...(hint.name !== undefined && { name: hint.name, exact: true }) }
  if (said === undefined && hint.text === undefined) {
    return {
      error:
        "it has no role or text of its own to check it by: point at an element with one, or write a locator from the snapshot",
    }
  }
  const sameText = (said: string) =>
    [facts.shown, facts.text].some(
      (t) => collapse(t).toLowerCase() === collapse(said).toLowerCase(),
    )
  const same =
    (said === undefined ||
      ((await indexAmong(page, said, element, false, false))?.index ?? -1) >= 0) &&
    (hint.text === undefined || sameText(hint.text))
  if (!same) {
    return {
      error:
        "it changed since the snapshot (it isn't what the snapshot said anymore): take a new snapshot",
    }
  }

  const candidates: SchemaLocator[] = []
  if (role !== undefined && hint.name) {
    candidates.push({ by: "role", role, name: hint.name, exact: true })
  }
  const placeholder = facts.placeholder.trim()
  if (placeholder !== "") candidates.push({ by: "placeholder", text: placeholder })
  // Its text as the snapshot said it (Playwright's own reading), then as the DOM has it.
  for (const t of new Set([collapse(hint.text ?? ""), text])) {
    if (t !== "" && t.length <= TEXT_MAX) candidates.push({ by: "text", text: t, exact: true })
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
      const now = await indexAmong(page, locator, element, exact, true)
      const fresh = exact ? await indexAmong(page, locator, element, false, true) : now
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
  // Among look-alikes: the candidate with the fewest (an id is never one of several).
  const fewest = found.filter((c) => c.locator.by !== "css").sort((a, b) => a.count - b.count)[0]
  if (fewest !== undefined) return { locator: fewest.locator, nth: fewest.index }
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
 * Where the element is among a locator's matches (visible ones only, as a replay counts them, when
 * `visible`; -1: not among them), and how many; undefined: a locator the rules refuse.
 */
async function indexAmong(
  page: Page,
  locator: SchemaLocator,
  element: ElementHandle<Element>,
  exact: boolean,
  visible: boolean,
): Promise<{ index: number; count: number } | undefined> {
  try {
    const all = toPlaywright(page, locator, exact)
    return await (visible ? visibleOnly(all) : all).evaluateAll(
      (els, target) => ({ index: (els as Element[]).indexOf(target), count: els.length }),
      element,
    )
  } catch {
    // A locator the rules refuse (a css probing a secret field): not this one.
    return undefined
  }
}
