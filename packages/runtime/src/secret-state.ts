import type { BrowserContext, ElementHandle, Page } from "playwright"

// Secret state per browser context (SECRETS-DESIGN §3 A5, A8), shared by every run on it, and the
// probing rule every locator goes through (targets.ts). A module of its own: no import cycle.

/** What a browser context's runs know about secrets: values, and the elements they went into. */
export interface ContextSecrets {
  values: Set<string>
  written: { page: Page; handle: ElementHandle }[]
}
const contextSecrets = new WeakMap<BrowserContext, ContextSecrets>()

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
