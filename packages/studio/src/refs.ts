// Acting by ref: the agent points at an element of its last snapshot (`{ ref: e12 }` where a step
// takes a locator), and the studio writes the lasting locator for it (runtime `lastingLocator`)
// before the step runs. A ref lives on the live page only: a scene's YAML never holds one.
import { type ElementHint, lastingLocator } from "@kiframe/runtime"
import type { ElementHandle, Page } from "playwright"
import { parse as parseYaml, stringify } from "yaml"

/** A ref as the snapshot writes it: `e12`, or `f1e12` (a frame's: after a navigation, or an iframe's). */
const REF = /^(f\d{1,4})?e\d{1,6}$/

/** A node of the snapshot, as its YAML key says it: `button "Save" [level=1] [ref=e8]`. */
const NODE = /^([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]*\])*)$/

/**
 * The role and accessible name of each ref in a snapshot (Playwright's `mode: "ai"` YAML), read
 * from its nodes only (read as YAML: a name with ": " or " #" is a quoted key): never from the
 * page's own text (a `text:` value, a node's text content), which may say anything.
 */
export function refsOf(snapshot: string): Map<string, ElementHint> {
  const refs = new Map<string, ElementHint>()
  const node = (key: string) => {
    const m = NODE.exec(key)
    const ref = m?.[3] !== undefined ? /\[ref=([a-z0-9]+)\]/.exec(m[3])?.[1] : undefined
    if (m === null || ref === undefined) return
    let name: string | undefined
    try {
      name = m[2] === undefined ? undefined : (JSON.parse(m[2]) as string)
    } catch {
      name = undefined
    }
    refs.set(ref, { role: m[1] ?? "", ...(name !== undefined && { name }) })
  }
  const walk = (items: unknown) => {
    if (!Array.isArray(items)) return
    for (const item of items as unknown[]) {
      if (typeof item === "string") node(item)
      else if (typeof item === "object" && item !== null) {
        for (const [key, children] of Object.entries(item)) {
          node(key)
          walk(children)
        }
      }
    }
  }
  try {
    walk(parseYaml(snapshot))
  } catch {
    // Not YAML (never seen): no refs, each refused as not of the last snapshot.
  }
  return refs
}

/** Is this value a ref: an object with a `ref`? (Anything beside it is refused when written.) */
function isRef(value: unknown): value is { ref: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { ref?: unknown }).ref === "string"
  )
}

/** The fields that take a target (a locator with `nth`); any other locator (a condition's
 * `visible`, a camera's `frame`, an ensure, `fallbacks`) is a locator alone. */
const TARGET_FIELDS = new Set(["target", "to", "until", "within"])

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
    // All at once (each waits a moment at most); the first refusal in their order says why.
    const list = [...refs]
    const whys = await Promise.all(list.map((ref) => pins.#pin(page, ref)))
    const at = whys.findIndex((why) => why !== undefined)
    if (at >= 0) {
      await pins.release()
      return { error: `ref ${list[at]}: ${whys[at]}` }
    }
    return pins
  }

  async #pin(page: Page, ref: string): Promise<string | undefined> {
    if (!REF.test(ref) || !this.#hints.has(ref)) {
      return "not a ref of the last snapshot: take a snapshot and use one of its [ref=…]"
    }
    // As the page is now, without waiting (the snapshot just saw it): `elementHandle()` waits for
    // something on some apps (1.6 s on Cal.com's login page) and timed out on every ref there.
    // A ref names an element (a snapshot node), never a text node.
    const handles = (await page
      .locator(`aria-ref=${ref}`)
      .elementHandles()
      .catch(() => [])) as ElementHandle<Element>[]
    const [handle, ...more] = handles
    await Promise.all(more.map((h) => h.dispose().catch(() => undefined)))
    if (handle === undefined) return "it isn't on the page anymore: take a new snapshot"
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
  async written(
    page: Page,
    value: unknown,
    field?: string,
  ): Promise<{ value: unknown } | { error: string }> {
    if (isRef(value)) {
      const extra = Object.keys(value).filter((k) => k !== "ref")
      if (extra.length > 0) {
        return {
          error: `ref ${value.ref}: a ref goes alone ({ ref: ${value.ref} }), without ${extra.join(", ")}`,
        }
      }
      const handle = this.#held.get(value.ref)
      if (handle === undefined) return { error: `ref ${value.ref}: not pinned` }
      const lasting = await lastingLocator(page, handle, this.#hints.get(value.ref), {
        nth: field !== undefined && TARGET_FIELDS.has(field),
      })
      if ("error" in lasting) return { error: `ref ${value.ref}: ${lasting.error}` }
      return {
        value: { ...lasting.locator, ...(lasting.nth !== undefined && { nth: lasting.nth }) },
      }
    }
    if (Array.isArray(value)) {
      const out: unknown[] = []
      for (const v of value) {
        // An item of a list (`fallbacks`) is a locator alone.
        const w = await this.written(page, v)
        if ("error" in w) return w
        out.push(w.value)
      }
      return { value: out }
    }
    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        const w = await this.written(page, v, k)
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
