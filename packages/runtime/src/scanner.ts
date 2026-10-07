import type { JSHandle, Page } from "playwright"
import type { Box } from "./motion.ts"

// The DOM-text scanner (APPROACHES §7.4, leak path 2): a secret shown elsewhere on screen ("Logged
// in as bob@acme.com", an error message, a prefilled field). The page's visible text is pulled into
// Node and matched HERE: secret values never enter the page (a hostile page could read them).
// Matching works on each block's text, so a value split across nodes (`bob@<b>acme.com</b>`) is
// found; its rects come from the page's own layout (Range rects).

/** One piece of visible text: a text node's data or a field's value, and the block it's in. */
interface Part {
  text: string
  block: number
}

interface Collected {
  parts: Part[]
  nodes: (Text | Element)[]
}

/** Runs in the page: the visible text nodes and field values in the viewport, in document order. */
function collect(): Collected {
  const parts: Part[] = []
  const nodes: (Text | Element)[] = []
  const blocks = new Map<Element, number>()
  const width = innerWidth
  const height = innerHeight
  const onScreen = (r: DOMRect) =>
    r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < width && r.top < height
  const displays = new Map<Element, string>()
  const displayOf = (el: Element) => {
    let d = displays.get(el)
    if (d === undefined) displays.set(el, (d = getComputedStyle(el).display))
    return d
  }
  const blockOf = (el: Element): number => {
    let at: Element | null = el
    while (at !== null) {
      const display = displayOf(at)
      if (!display.startsWith("inline") && display !== "contents") break
      at = at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? null
    }
    let key = at ?? document.documentElement
    // Flex and grid items compute to `block` but read as one line (a name chip, a tag): their
    // container is the block.
    while (key.parentElement !== null && /flex|grid/.test(displayOf(key.parentElement))) {
      key = key.parentElement
    }
    let id = blocks.get(key)
    if (id === undefined) blocks.set(key, (id = blocks.size))
    return id
  }
  const walk = (root: Document | ShadowRoot) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (n instanceof Element) {
        if (n.shadowRoot !== null) walk(n.shadowRoot)
        const field =
          (n instanceof HTMLInputElement && !["password", "hidden"].includes(n.type)) ||
          n instanceof HTMLTextAreaElement
        if (field && (n as HTMLInputElement).value !== "") {
          if (!onScreen(n.getBoundingClientRect())) continue
          parts.push({ text: (n as HTMLInputElement).value, block: -1 - nodes.length })
          nodes.push(n)
        }
        continue
      }
      const text = n as Text
      // Directly in a shadow root (a Lit template): its host stands for the parent.
      const root = text.parentNode
      const parent = text.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
      if (parent === null || text.data.trim() === "") continue
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"].includes(parent.tagName)) continue
      const range = document.createRange()
      range.selectNodeContents(text)
      if (![...range.getClientRects()].some(onScreen)) continue
      const style = getComputedStyle(parent)
      if (style.visibility === "hidden" || style.opacity === "0") continue
      parts.push({ text: text.data, block: blockOf(parent) })
      nodes.push(text)
    }
  }
  walk(document)
  return { parts, nodes }
}

/**
 * How a secret value is found in text (SECRETS-DESIGN §5 R2), by the scanner and by the runtime's
 * checks alike: case-insensitive; whitespace in the value matches any whitespace or none (the
 * browser collapses it; a space can be a node of its own); a value under 6 characters only as a
 * whole word (a username "admin" isn't in "administrators").
 */
export function valuePattern(value: string, flags = "giu"): RegExp {
  const body = value.trim().split(/\s+/).map(escapeRegExp).join("\\s*")
  return new RegExp(
    value.trim().length < 6 ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body,
    flags,
  )
}

/** A string as a literal in a regular expression (valid with the `u` flag too). */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** A match's span inside one part. */
interface Span {
  part: number
  start: number
  end: number
}

/** Runs in the page: the union box of each match (its spans' Range rects, or the field's box). */
function rectsOf(
  c: Collected,
  matches: Span[][],
): ({ x: number; y: number; width: number; height: number } | null)[] {
  return matches.map((spans) => {
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    for (const s of spans) {
      const node = c.nodes[s.part]
      // Re-rendered since it was read (detached, or its text changed): the offsets may be wrong.
      // Its parent's box if it's still there, else unsure (the whole scan fails closed).
      if (node === undefined || !node.isConnected) return null
      let rects: DOMRect[]
      if (node instanceof Element) rects = [node.getBoundingClientRect()]
      else if (node.data !== c.parts[s.part]?.text) {
        const parent = node.parentElement
        if (parent === null) return null
        rects = [parent.getBoundingClientRect()]
      } else {
        const range = document.createRange()
        range.setStart(node, Math.min(s.start, node.length))
        range.setEnd(node, Math.min(s.end, node.length))
        rects = [...range.getClientRects()]
      }
      for (const r of rects) {
        if (r.width === 0 || r.height === 0) continue
        x1 = Math.min(x1, r.left)
        y1 = Math.min(y1, r.top)
        x2 = Math.max(x2, r.right)
        y2 = Math.max(y2, r.bottom)
      }
    }
    return x1 === Infinity ? null : { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  })
}

/** Where `values` occur in `parts`, per block, ignoring case: each match as the spans it covers. */
export function matchParts(parts: readonly Part[], values: Iterable<string>): Span[][] {
  // Case-insensitive regexes on the text itself: offsets stay the original string's (lowering the
  // case can change a string's length: "İ"). Whitespace in a value matches any whitespace, or none
  // (the browser collapses it; a space between two nodes can be a node of its own, not collected).
  const needles = [...new Set([...values].filter((v) => v.trim() !== ""))].map((v) =>
    valuePattern(v),
  )
  if (needles.length === 0) return []
  const out: Span[][] = []
  let i = 0
  while (i < parts.length) {
    // One block: consecutive parts with the same block id, concatenated.
    const block = parts[i]!.block
    const members: { part: number; from: number }[] = []
    let text = ""
    for (; i < parts.length && parts[i]!.block === block; i++) {
      members.push({ part: i, from: text.length })
      text += parts[i]!.text
    }
    for (const pattern of needles) {
      for (const m of text.matchAll(pattern)) {
        const at = m.index
        const end = at + m[0].length
        const spans: Span[] = []
        for (const [k, member] of members.entries()) {
          const mEnd = k + 1 < members.length ? members[k + 1]!.from : text.length
          if (member.from >= end || mEnd <= at) continue
          spans.push({
            part: member.part,
            start: Math.max(at, member.from) - member.from,
            end: Math.min(end, mEnd) - member.from,
          })
        }
        out.push(spans)
      }
    }
  }
  return out
}

/**
 * The boxes (viewport CSS pixels) of every visible occurrence of a secret value on the page, in
 * document order; null for an occurrence re-rendered during the scan (unsure). Throws if the page
 * can't be scanned.
 */
export async function scanSecretTextPartly(
  page: Page,
  values: Iterable<string>,
): Promise<(Box | null)[]> {
  const list = [...values]
  if (list.every((v) => v.trim() === "")) return []
  const handle: JSHandle<Collected> = await page.evaluateHandle(collect)
  try {
    const parts = await handle.evaluate((c) => c.parts)
    const matches = matchParts(parts, list)
    if (matches.length === 0) return []
    return await handle.evaluate(rectsOf, matches)
  } finally {
    await handle.dispose().catch(() => undefined)
  }
}

/** `scanSecretTextPartly`, all or nothing: throws when any occurrence is unsure (fails closed). */
export async function scanSecretText(page: Page, values: Iterable<string>): Promise<Box[]> {
  const boxes = await scanSecretTextPartly(page, values)
  if (boxes.some((b) => b === null)) throw new Error("the page changed during the scan")
  return boxes as Box[]
}
