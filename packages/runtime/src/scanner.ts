import { PNG } from "pngjs"
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
  const blockOf = (el: Element): number => {
    let at: Element | null = el
    while (at !== null) {
      const display = getComputedStyle(at).display
      if (!display.startsWith("inline") && display !== "contents") break
      at = at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? null
    }
    const key = at ?? document.documentElement
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
      const parent = text.parentElement
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
      if (node === undefined) continue
      let rects: DOMRect[]
      if (node instanceof Element) rects = [node.getBoundingClientRect()]
      else {
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
  const needles = [
    ...new Set([...values].filter((v) => v.trim() !== "").map((v) => v.toLowerCase())),
  ]
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
    const haystack = text.toLowerCase()
    for (const needle of needles) {
      for (
        let at = haystack.indexOf(needle);
        at !== -1;
        at = haystack.indexOf(needle, at + needle.length)
      ) {
        const end = at + needle.length
        const spans: Span[] = []
        for (const [k, m] of members.entries()) {
          const mEnd = k + 1 < members.length ? members[k + 1]!.from : text.length
          if (m.from >= end || mEnd <= at) continue
          spans.push({
            part: m.part,
            start: Math.max(at, m.from) - m.from,
            end: Math.min(end, mEnd) - m.from,
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
 * document order. Throws if the page can't be scanned (callers fail closed).
 */
export async function scanSecretText(page: Page, values: Iterable<string>): Promise<Box[]> {
  const list = [...values]
  if (list.every((v) => v.trim() === "")) return []
  const handle: JSHandle<Collected> = await page.evaluateHandle(collect)
  try {
    const parts = await handle.evaluate((c) => c.parts)
    const matches = matchParts(parts, list)
    if (matches.length === 0) return []
    const boxes = await handle.evaluate(rectsOf, matches)
    return boxes.filter((b): b is Box => b !== null)
  } finally {
    await handle.dispose().catch(() => undefined)
  }
}

/**
 * A screenshot of the viewport for the model (APPROACHES §7.4, leak path 8): every visible secret
 * value painted over, in Node, before it leaves the runtime. Scanned before and after the
 * screenshot, and the union covered (the page may change in between). Throws if the page can't be
 * scanned: no screenshot rather than an unchecked one.
 */
export async function screenshotForModel(page: Page, values: Iterable<string>): Promise<Buffer> {
  const list = [...values]
  const before = await scanSecretText(page, list)
  const shot = await page.screenshot({ type: "png" })
  const after = await scanSecretText(page, list)
  const boxes = [...before, ...after]
  if (boxes.length === 0) return shot
  const png = PNG.sync.read(shot)
  // Screenshot pixels per CSS pixel (the device scale factor).
  const scale = png.width / (await page.evaluate(() => innerWidth))
  for (const box of boxes) {
    // Grown by 2 CSS px: anti-aliased glyph edges stay covered.
    const x1 = Math.max(0, Math.floor((box.x - 2) * scale))
    const y1 = Math.max(0, Math.floor((box.y - 2) * scale))
    const x2 = Math.min(png.width, Math.ceil((box.x + box.width + 2) * scale))
    const y2 = Math.min(png.height, Math.ceil((box.y + box.height + 2) * scale))
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const i = (y * png.width + x) * 4
        png.data[i] = 40
        png.data[i + 1] = 40
        png.data[i + 2] = 40
        png.data[i + 3] = 255
      }
    }
  }
  return PNG.sync.write(png)
}
