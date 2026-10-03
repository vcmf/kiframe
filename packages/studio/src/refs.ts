// Acting by ref: the agent points at an element of its last snapshot (`{ ref: e12 }` where a step
// takes a locator), and the studio writes the lasting locator for it (runtime `lastingLocator`)
// before the step runs. A ref lives on the live page only: a scene's YAML never holds one.
import { type ElementHint, lastingLocator } from "@kiframe/runtime"
import type { ElementHandle, Page } from "playwright"
import { stringify } from "yaml"

/** A ref as the snapshot writes it: `e12`, or `f1e12` (a frame's: after a navigation, or an iframe's). */
const REF = /^(f\d{1,4})?e\d{1,6}$/

/**
 * The role and accessible name of each ref in a snapshot (Playwright's `mode: "ai"` lines:
 * `- button "Save" [ref=e8]`), read from the text it gave.
 */
export function refsOf(snapshot: string): Map<string, ElementHint> {
  const refs = new Map<string, ElementHint>()
  const line = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?.*?\[ref=([a-z0-9]+)\]/
  for (const text of snapshot.split("\n")) {
    const m = line.exec(text)
    if (m === null) continue
    const [, role = "", quoted, ref = ""] = m
    let name: string | undefined
    if (quoted !== undefined) {
      try {
        name = JSON.parse(`"${quoted}"`) as string
      } catch {
        name = undefined
      }
    }
    refs.set(ref, { role, ...(name !== undefined && { name }) })
  }
  return refs
}

/** Is this value a ref (and only that): `{ ref: e12 }`? */
function isRef(value: unknown): value is { ref: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { ref?: unknown }).ref === "string"
  )
}

/** Every ref in a value (a step, a list of steps), once each. */
export function refsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (isRef(value)) found.add(value.ref)
  else if (Array.isArray(value)) for (const v of value) refsIn(v, found)
  else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) refsIn(v, found)
  }
  return found
}

/**
 * The elements refs name, held from before any step runs (a later snapshot, ours or a step's,
 * makes Playwright forget the refs): each found now, or why not.
 */
export class Pins {
  readonly #held = new Map<string, ElementHandle<Element>>()
  readonly #hints: Map<string, ElementHint>

  private constructor(hints: Map<string, ElementHint>) {
    this.#hints = hints
  }

  static async of(
    page: Page,
    refs: Iterable<string>,
    hints: Map<string, ElementHint>,
  ): Promise<Pins | { error: string }> {
    const pins = new Pins(hints)
    for (const ref of refs) {
      const why = await pins.#pin(page, ref)
      if (why !== undefined) {
        await pins.release()
        return { error: `ref ${ref}: ${why}` }
      }
    }
    return pins
  }

  async #pin(page: Page, ref: string): Promise<string | undefined> {
    if (!REF.test(ref) || !this.#hints.has(ref)) {
      return "not a ref of the last snapshot: take a snapshot and use one of its [ref=…]"
    }
    const handle = await page
      .locator(`aria-ref=${ref}`)
      .elementHandle({ timeout: 1000 })
      .catch(() => null)
    if (handle === null) return "it isn't on the page anymore: take a new snapshot"
    // Inside an iframe: a step's locators reach the page's own elements only.
    if ((await handle.ownerFrame()) !== page.mainFrame()) {
      await handle.dispose().catch(() => undefined)
      return "it's inside a frame (an iframe): steps reach the page's own elements only"
    }
    this.#held.set(ref, handle)
    return undefined
  }

  /**
   * The value with each ref replaced by its lasting locator (`nth` alongside when it needs one), as
   * the page is now; or why a ref has none.
   */
  async written(page: Page, value: unknown): Promise<{ value: unknown } | { error: string }> {
    if (isRef(value)) {
      const handle = this.#held.get(value.ref)
      if (handle === undefined) return { error: `ref ${value.ref}: not pinned` }
      const lasting = await lastingLocator(page, handle, this.#hints.get(value.ref))
      if ("error" in lasting) return { error: `ref ${value.ref}: ${lasting.error}` }
      return {
        value: { ...lasting.locator, ...(lasting.nth !== undefined && { nth: lasting.nth }) },
      }
    }
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (const v of value) {
        const w = await this.written(page, v)
        if ("error" in w) return w
        out.push(w.value)
      }
      return { value: out }
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        const w = await this.written(page, v)
        if ("error" in w) return w
        out[k] = w.value
      }
      return { value: out }
    }
    return { value }
  }

  async release(): Promise<void> {
    await Promise.all([...this.#held.values()].map((h) => h.dispose().catch(() => undefined)))
    this.#held.clear()
  }
}

/** A step as the agent writes it in the YAML: one flow line. */
export function asWritten(step: unknown): string {
  return stringify(step, { collectionStyle: "flow", lineWidth: 0 }).trim()
}
