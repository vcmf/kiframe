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
 * SECRETS-DESIGN §3 A8: while a context knows secret values, a CSS locator may not test a value:
 * no `value` attribute test, and no selector engine other than plain CSS (`xpath=`, `//…`, `>>`
 * chains, `text=`…: XPath can test `@value`). Value-independent (a refusal that depended on the
 * value would itself leak it).
 */
export function assertNotProbing(context: BrowserContext, selector: string): void {
  if (secretsOf(context).values.size === 0) return
  const s = selector.trim()
  const engine =
    /^[a-z][\w-]*(:[\w-]+)?=/i.test(s) ||
    s.startsWith("//") ||
    s.startsWith("..") ||
    s.includes(">>")
  if (engine) {
    throw new ProbeRefusal(
      "only plain CSS selectors in a scene that knows a secret (no selector engines)",
    )
  }
  if (/\[\s*value\b/i.test(s)) {
    throw new ProbeRefusal("no `value` attribute test in a selector while a secret is known")
  }
}
