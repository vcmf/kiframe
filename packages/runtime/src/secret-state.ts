import type { BrowserContext, ElementHandle, Page } from "playwright"
import { valuePattern } from "./scanner.ts"

// Secret state per browser context (SECRETS-DESIGN §3 A5, A8), shared by every run on it, and the
// probing rule every locator goes through (targets.ts). A module of its own: no import cycle.

/** What a browser context's runs know about secrets: values, and the elements they went into. */
export interface ContextSecrets {
  values: Set<string>
  written: { page: Page; handle: ElementHandle }[]
  /**
   * A field holding a secret is on the driven page (§3 A8): role, label, text and placeholder
   * locators then match their names exactly (an accessible name can include a nested input's
   * value). Updated at every step boundary.
   */
  exactNames: boolean
}
const contextSecrets = new WeakMap<BrowserContext, ContextSecrets>()

/**
 * The secret state of a browser context (SECRETS-DESIGN §3 A5: "while secrets are known in a
 * context"): shared by every run on it, gone with it (its handles die with the context).
 */
export function secretsOf(context: BrowserContext): ContextSecrets {
  let state = contextSecrets.get(context)
  if (state === undefined)
    contextSecrets.set(context, (state = { values: new Set(), written: [], exactNames: false }))
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
      "only simple CSS selectors while a secret is known (tags, #ids, .classes, attributes other than value)",
    )
  }
}

const PSEUDOS = new Set([
  "first-child",
  "last-child",
  "only-child",
  "checked",
  "disabled",
  "enabled",
  "focus",
])
const NTH_PSEUDOS = new Set(["nth-child", "nth-of-type"])
const ATTRIBUTE_OPS = ["~=", "|=", "^=", "$=", "*=", "="]

/** The allowlisted CSS subset of A8 (a tiny recursive-descent parser). Exported for its tests. */
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
    if (name === undefined || name.toLowerCase().includes("value")) return false
    ws()
    if (peek() === "]") return (i++, true)
    const op = ATTRIBUTE_OPS.find((o) => s.startsWith(o, i))
    if (op === undefined) return false
    i += op.length
    ws()
    if (!attributeValue()) return false
    if (ws() && /[is]/i.test(peek())) i++
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
    if (name === "not") {
      if (peek() !== "(") return false
      i++
      if (!list(")")) return false
      return peek() === ")" && (i++, true)
    }
    return false
  }
  const compound = (): boolean => {
    let parts = 0
    if (/[a-zA-Z_-]/.test(peek())) {
      if (ident() === undefined) return false
      parts++
    }
    for (;;) {
      const c = peek()
      if (c === "#" || c === ".") {
        i++
        if (ident() === undefined) return false
      } else if (c === "[") {
        if (!attribute()) return false
      } else if (c === ":") {
        if (!pseudo()) return false
      } else break
      parts++
    }
    return parts > 0
  }
  const complex = (end: string): boolean => {
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
  const list = (end: string): boolean => {
    ws()
    if (!complex(end)) return false
    while (peek() === ",") {
      i++
      ws()
      if (!complex(end)) return false
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
 * The page's side of the check (runs in the page): whether a written field is still rendered, and
 * the rendered text-like fields' values (read out, matched in Node; never hidden inputs).
 */
function renderedFields(written: Element[]): { writtenRendered: boolean; values: string[] } {
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
      if (field && (el as HTMLInputElement).value !== "" && el.checkVisibility()) {
        values.push((el as HTMLInputElement).value)
      }
      if (el.shadowRoot !== null) visit(el.shadowRoot)
    }
  }
  visit(document)
  // A written field hidden (a closed login dialog) is in no accessible name: it doesn't count.
  return { writtenRendered: written.some((e) => e.isConnected && e.checkVisibility()), values }
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

/**
 * §3 A8: whether a field holding a secret is on the page right now (a field a secret was written
 * to, still rendered, or a rendered field whose value contains a known value). Called by every
 * polling loop before it builds a name locator, so a field that renders mid-step is seen at once.
 * Unsure (the page is navigating): true while values are known (fails closed).
 */
export async function refreshExactNames(page: Page): Promise<boolean> {
  const state = secretsOf(page.context())
  if (state.values.size === 0) return (state.exactNames = false)
  const found = await page.evaluate(renderedFields, await liveWritten(page)).catch(() => undefined)
  return (state.exactNames =
    found === undefined ||
    found.writtenRendered ||
    found.values.some((v) => containsKnownValue(state.values, v)))
}
