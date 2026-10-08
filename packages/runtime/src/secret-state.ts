import type { BrowserContext, ElementHandle, Page } from "playwright"
import { valuePattern } from "./scanner.ts"

// Secret state per browser context (SECRETS-DESIGN §3 A5, A8), shared by every run on it, and the
// probing rule every locator goes through (targets.ts). A module of its own: no import cycle.

/** What a browser context's runs know about secrets: values, and the elements they went into. */
export interface ContextSecrets {
  values: Set<string>
  written: { page: Page; handle: ElementHandle }[]
}
const contextSecrets = new WeakMap<BrowserContext, ContextSecrets>()

/**
 * The secret values a browser context resolved or was given (read-only: for a host scrubbing what
 * it shows the agent, in the same process; never sent anywhere).
 */
export function knownValuesOf(context: BrowserContext): ReadonlySet<string> {
  return secretsOf(context).values
}

/**
 * Adds values a person typed in a context's page (a handover: the agent saw nothing of it) to what
 * the context knows: from then on they're scrubbed and masked as any secret's (for the context's
 * life, never stored).
 */
export function addKnownValues(context: BrowserContext, values: Iterable<string>): void {
  const known = secretsOf(context).values
  for (const v of values) if (v.trim() !== "") known.add(v)
}

/**
 * The secret state of a browser context (SECRETS-DESIGN §3 A5: "while secrets are known in a
 * context"): shared by every run on it, gone with it (its handles die with the context).
 */
export function secretsOf(context: BrowserContext): ContextSecrets {
  let state = contextSecrets.get(context)
  if (state === undefined) contextSecrets.set(context, (state = { values: new Set(), written: [] }))
  return state
}

/** A locator was refused: it could test a known value (§3 A8). The message holds no value. */
export class ProbeRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProbeRefusal"
  }
}

/**
 * SECRETS-DESIGN §3 A8: while a context knows secret values, a CSS locator must parse under a
 * strict subset grammar (an allowlist: escapes, namespaces and Playwright's engine syntax never
 * parse). Value-independent: a refusal that depended on the value would itself leak it.
 */
export function assertNotProbing(context: BrowserContext, selector: string): void {
  if (secretsOf(context).values.size === 0) return
  if (!isSafeSelector(selector)) {
    throw new ProbeRefusal(
      `only simple CSS selectors while a secret is known: ${SAFE_SELECTOR_RULES}`,
    )
  }
}

const PSEUDOS = new Set([
  "first-child",
  "last-child",
  "only-child",
  "first-of-type",
  "last-of-type",
  "only-of-type",
  "empty",
  "checked",
  "disabled",
  "enabled",
  "focus",
])
const NTH_PSEUDOS = new Set(["nth-child", "nth-of-type", "nth-last-child", "nth-last-of-type"])
const ATTRIBUTE_OPS = ["~=", "|=", "^=", "$=", "*=", "="]
/**
 * Attribute names a selector may test (§3 A8): an allowlist (frameworks copy a field's value into
 * `value`, `ng-reflect-model`, `aria-valuetext`: never allowed). Tests are presence or a whole
 * value (`=`), so a guess must be a whole value, like exact names; only `class` and `id` also take
 * the partial operators (hashed CSS-module classes, vendor ids: `[class*=CookieBanner_]`).
 */
const ATTRIBUTE_NAMES = new Set([
  "id",
  "class",
  "name",
  "type",
  "role",
  "for",
  "lang",
  "dir",
  "tabindex",
  "disabled",
  "checked",
  "selected",
  "readonly",
  "required",
  "hidden",
  "open",
  "contenteditable",
  "draggable",
  "spellcheck",
  "inert",
  "multiple",
  "autofocus",
  "data-testid",
  "data-test",
  "data-test-id",
  "data-qa",
  "data-cy",
  "data-state",
])
const TEXT_ATTRIBUTES = new Set([
  "alt",
  "title",
  "href",
  "src",
  "placeholder",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
])
/** ARIA states and relations (ids, booleans, tokens): never page text. Any other aria-* is refused. */
const ARIA_STATES = new Set([
  "aria-expanded",
  "aria-selected",
  "aria-checked",
  "aria-pressed",
  "aria-disabled",
  "aria-hidden",
  "aria-current",
  "aria-haspopup",
  "aria-modal",
  "aria-invalid",
  "aria-busy",
  "aria-live",
  "aria-orientation",
  "aria-sort",
  "aria-level",
  "aria-controls",
  "aria-owns",
  "aria-labelledby",
  "aria-describedby",
  "aria-activedescendant",
  "aria-required",
  "aria-readonly",
  "aria-multiselectable",
  "aria-autocomplete",
  "aria-rowindex",
  "aria-colindex",
  "aria-posinset",
  "aria-setsize",
  "aria-rowcount",
  "aria-colcount",
  "aria-rowspan",
  "aria-colspan",
  "aria-atomic",
  "aria-relevant",
  "aria-errormessage",
  "aria-details",
  "aria-flowto",
])

/** Attributes that take the partial operators too (`^=`, `$=`, `*=`, `|=`). */
const PARTIAL_OK = new Set(["class", "id"])
const ALLOWED_ATTRIBUTES = new Set([...ATTRIBUTE_NAMES, ...TEXT_ATTRIBUTES, ...ARIA_STATES])
const allowedAttribute = (name: string) => ALLOWED_ATTRIBUTES.has(name.toLowerCase())

/** The A8 grammar in words, for every message that refuses a selector. */
export const SAFE_SELECTOR_RULES =
  "tags, *, #ids, .classes, attribute presence or = (id, class, name, type, role, for, href, src, alt, title, placeholder, aria-label, aria-* states, data-testid/-test/-qa/-cy/-state; never value), ^= $= *= |= on class and id only, combinators, :not() :has() :is() :where() and structural pseudo-classes; no selector engines (SECRETS-DESIGN §3 A8 lists them)"

/**
 * The allowlisted CSS subset of A8 (a tiny recursive-descent parser). Exported for its tests.
 * Escapes only inside class and id names (`.md\\:hidden`); `*`; structural and state
 * pseudo-classes; `:not(…)`, `:has(…)` (relative), `:is(…)` and `:where(…)` with the same grammar
 * inside.
 */
export function isSafeSelector(selector: string): boolean {
  const s = selector.trim()
  let i = 0
  const peek = () => s[i] ?? ""
  const ws = () => {
    const start = i
    while (/\s/.test(peek())) i++
    return i > start
  }
  const ident = (): string | undefined => {
    const m = /^-?[a-zA-Z_][a-zA-Z0-9_-]*/.exec(s.slice(i))
    if (m === null) return undefined
    i += m[0].length
    return m[0]
  }
  /** A class or id name: identifier characters and CSS escapes (never an attribute name). */
  const escapedIdent = (): boolean => {
    const start = i
    for (;;) {
      const c = peek()
      if (/[a-zA-Z0-9_-]/.test(c)) i++
      else if (c === "\\") {
        const next = s[i + 1] ?? ""
        if (next === "" || /[\n\r\f]/.test(next)) return false
        const hex = /^[0-9a-fA-F]{1,6}\s?/.exec(s.slice(i + 1))
        i += 1 + (hex !== null ? hex[0].length : 1)
      } else break
    }
    return i > start
  }
  const attributeValue = (): boolean => {
    const q = peek()
    if (q === '"' || q === "'") {
      const end = s.indexOf(q, i + 1)
      if (end === -1) return false
      const body = s.slice(i + 1, end)
      if (/[\\\n\r\f]/.test(body)) return false
      i = end + 1
      return true
    }
    return /^[a-zA-Z0-9_-]+/.test(s.slice(i)) && ident() !== undefined
  }
  const attribute = (): boolean => {
    i++ // [
    ws()
    const name = ident()
    if (name === undefined || !allowedAttribute(name)) return false
    ws()
    if (peek() === "]") return (i++, true)
    const op = ATTRIBUTE_OPS.find((o) => s.startsWith(o, i))
    if (op === undefined) return false
    // Whole-value tests (§3 A8): a partial operator (or `~=`, one word of a value) could test a
    // displayed identity, `:has()` included; only `class` and `id` take them.
    if (op !== "=" && !PARTIAL_OK.has(name.toLowerCase())) return false
    i += op.length
    ws()
    const quoted = peek() === '"' || peek() === "'"
    if (!attributeValue()) return false
    // The case flag: after whitespace, or right after a quoted value (`[aria-label='Close'i]`).
    if ((ws() || quoted) && /^[is](?=[\s\]])/i.test(s.slice(i))) i++
    ws()
    return peek() === "]" && (i++, true)
  }
  const pseudo = (): boolean => {
    i++ // :
    const name = ident()
    if (name === undefined) return false
    if (PSEUDOS.has(name)) return true
    if (NTH_PSEUDOS.has(name)) {
      if (peek() !== "(") return false
      const end = s.indexOf(")", i)
      if (end === -1 || !/^[\s0-9n+-]*$|^\s*(odd|even)\s*$/.test(s.slice(i + 1, end))) return false
      i = end + 1
      return true
    }
    if (name === "not" || name === "has" || name === "is" || name === "where") {
      if (peek() !== "(") return false
      i++
      // `:has` takes relative selectors (`:has(> .banner)`).
      if (!list(")", name === "has")) return false
      return peek() === ")" && (i++, true)
    }
    return false
  }
  const compound = (): boolean => {
    let parts = 0
    if (peek() === "*") {
      i++
      parts++
    } else if (/[a-zA-Z_-]/.test(peek())) {
      if (ident() === undefined) return false
      parts++
    }
    for (;;) {
      const c = peek()
      if (c === "#" || c === ".") {
        i++
        if (!escapedIdent()) return false
      } else if (c === "[") {
        if (!attribute()) return false
      } else if (c === ":") {
        if (!pseudo()) return false
      } else break
      parts++
    }
    return parts > 0
  }
  const complex = (end: string, relative: boolean): boolean => {
    if (relative && /[>+~]/.test(peek())) {
      i++
      ws()
    }
    if (!compound()) return false
    for (;;) {
      const spaced = ws()
      const c = peek()
      if (c === "" || c === "," || c === end) return true
      if (c === ">" || c === "+" || c === "~") {
        i++
        ws()
      } else if (!spaced) return false
      if (!compound()) return false
    }
  }
  const list = (end: string, relative = false): boolean => {
    ws()
    if (!complex(end, relative)) return false
    while (peek() === ",") {
      i++
      ws()
      if (!complex(end, relative)) return false
    }
    return true
  }
  return s !== "" && list("") && i === s.length
}

/** Whether a text contains a known value (in Node: values never go to the page). */
export function containsKnownValue(
  values: Iterable<string>,
  text: string | null | undefined,
): boolean {
  if (text === null || text === undefined || text === "") return false
  // The scanner's matcher (R2): whitespace-tolerant, short values as whole words.
  for (const v of values) if (v.trim() !== "" && valuePattern(v, "iu").test(text)) return true
  return false
}

/**
 * The elements secrets were written to that are still in this page's current document. Closed
 * pages and removed elements are pruned (their handles released): the list stays small, and a
 * stale handle never makes a check fail.
 */
export async function liveWritten(page: Page): Promise<ElementHandle<Element>[]> {
  const state = secretsOf(page.context())
  const all = [...state.written]
  const live = await Promise.all(
    all.map((w) =>
      w.page.isClosed()
        ? Promise.resolve(false)
        : w.handle.evaluate((e) => e.isConnected).catch(() => false),
    ),
  )
  for (const [i, w] of all.entries()) {
    if (live[i]) continue
    const at = state.written.indexOf(w)
    if (at !== -1) state.written.splice(at, 1)
    void w.handle.dispose().catch(() => undefined)
  }
  return all
    .filter((w, i) => live[i] && w.page === page)
    .map((w) => w.handle as ElementHandle<Element>)
}

/**
 * The page's side of the check (runs in the page): the text-like fields' values (read out, matched in Node; never hidden inputs). Visible or not:
 * Playwright names hidden elements through `aria-labelledby`, labels and shadow hosts, so a hidden
 * field isn't taken out of every name (fails closed; a login kept mounted but hidden keeps exact
 * names on).
 */
function fieldsOnPage(): string[] {
  const values: string[] = []
  const nonText = new Set([
    "hidden",
    "checkbox",
    "radio",
    "submit",
    "button",
    "reset",
    "image",
    "file",
    "range",
    "color",
  ])
  const visit = (root: Document | ShadowRoot) => {
    for (const el of root.querySelectorAll("*")) {
      const field =
        (el instanceof HTMLInputElement && !nonText.has(el.type)) ||
        el instanceof HTMLTextAreaElement
      if (field && (el as HTMLInputElement).value !== "")
        values.push((el as HTMLInputElement).value)
      if (el.shadowRoot !== null) visit(el.shadowRoot)
    }
  }
  visit(document)
  return values
}

/** Whether a locator matches a name partially (the only kind the exact-names rule changes). */
export function isPartialName(locator: {
  by: string
  name?: string | undefined
  exact?: boolean | undefined
}): boolean {
  if (locator.exact === true) return false
  if (locator.by === "role") return locator.name !== undefined
  return locator.by === "label" || locator.by === "text" || locator.by === "placeholder"
}

/** The exact-names decision of the moment: `unsure` when the page couldn't be read (navigating). */
export interface ExactNames {
  exact: boolean
  unsure: boolean
}

/**
 * §3 A8: whether a field holding a secret is on the page right now (a field a secret was written
 * to, still attached, or a text-like field whose value contains a known value). Unsure (the page is
 * navigating): exact while values are known (fails closed), and `unsure` so a caller can poll
 * again rather than conclude.
 */
export async function refreshExactNames(page: Page): Promise<ExactNames> {
  const state = secretsOf(page.context())
  if (state.values.size === 0) return { exact: false, unsure: false }
  // A written field still attached decides it (no need to read the page's fields).
  if ((await liveWritten(page)).length > 0) return { exact: true, unsure: false }
  const values = await page.evaluate(fieldsOnPage).catch(() => undefined)
  if (values === undefined) return { exact: true, unsure: true }
  return { exact: values.some((v) => containsKnownValue(state.values, v)), unsure: false }
}

/** The hint every error adds when the exact-names rule (§3 A8) was on. */
export const EXACT_NAMES_HINT =
  " (names match exactly while a field holding a secret is on the page)"

/** The exact-names decision for some locators: a refresh only if one of them has a partial name. */
export async function exactNamesFor(
  page: Page,
  locators: readonly Parameters<typeof isPartialName>[0][],
): Promise<ExactNames> {
  return locators.some(isPartialName) ? refreshExactNames(page) : { exact: false, unsure: false }
}
