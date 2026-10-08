import { PNG } from "pngjs"
import type { CDPSession, Page } from "playwright"
import type { Box } from "./motion.ts"
import { secretMatcher } from "./run/secrets.ts"
import { liveWritten } from "./secret-state.ts"

// A screenshot for the model (APPROACHES §7.4, leak path 8; the agent's `look`), masked from what
// the browser itself lays out: one DOMSnapshot per scan (its text as painted, its form controls,
// its documents), never a walk of the DOM listing the places text can show. Secret values are
// matched HERE, in Node (never sent into the page); the image is painted over before it leaves.

/** What `maskedScreenshot` gives: the image (PNG, CSS pixels) and how much of it is masked. */
export interface MaskedShot {
  png: Buffer
  width: number
  height: number
  /** The share of the image painted over (0–1, overlaps counted twice: an estimate). */
  masked: number
}

/** A screenshot that can't be taken as asked, whatever the page does next (said to the agent). */
export class LookRefusal extends Error {}

/** Captures tried when the page changes between the scans around one (then refused). */
const LOOK_TRIES = 3
/** One look, all its tries: at most this long. */
const LOOK_MS = 15_000

/** Elements that host another document: one whose document the snapshot hasn't is masked whole. */
const FRAME_OWNERS = new Set(["IFRAME", "FRAME", "OBJECT", "EMBED", "FENCEDFRAME"])

/** Text never painted (a script's, a style's): never matched (a page's own JSON holding the
 *  user's email would mask the whole page). */
const UNPAINTED = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE", "HEAD"])

/** A page's snapshot still running (a hung renderer): never another queued behind it. */
const pending = new WeakMap<Page, Promise<unknown>>()

/**
 * The live page as an image with every place a secret value may show painted over: the text the
 * browser lays out (its own strings, so `::before`, closed shadow roots, hidden text, same-origin
 * frames), the page's text nodes too (a safety net: a select's options, SVG or MathML text), the
 * form controls' values, placeholders, labels and alt texts (never a password field: matching it
 * would answer a guess typed in it), every field a secret was written to, the project's redaction
 * selectors (in every frame), and a frame holding a value, or whose document can't be read
 * (cross-origin), whole. Scanned before and after the capture (the page as it is, animations
 * running): masks, documents and the `measure`d box must agree, else captured again, then refused.
 * `measure`: a box to cut the image to (a ref), measured in both scans. Throws when unsure: no image
 * rather than an unchecked one.
 */
export async function maskedScreenshot(
  page: Page,
  values: Iterable<string>,
  opts: {
    selectors?: readonly string[]
    measure?: () => Promise<Box | null>
    signal?: AbortSignal
  } = {},
): Promise<MaskedShot> {
  const list = [...values].filter((v) => v.trim() !== "")
  const matcher = secretMatcher(list)
  const deadline = Date.now() + LOOK_MS
  const session = await untilStopped(page.context().newCDPSession(page), opts.signal)
  try {
    let last: unknown = new Error("the page kept changing: no screenshot")
    for (let tries = 0; tries < LOOK_TRIES && Date.now() < deadline; tries++) {
      opts.signal?.throwIfAborted()
      const scan = () => untilStopped(scanFor(page, session, matcher, opts, deadline), opts.signal)
      try {
        const before = await scan()
        const shot = await untilStopped(
          page.screenshot({
            type: "png",
            scale: "css",
            timeout: Math.max(1, deadline - Date.now()),
          }),
          opts.signal,
        )
        const after = await scan()
        if (!sameScan(before, after)) continue
        if (opts.measure !== undefined && before.clip === null) {
          throw new LookRefusal("the element isn't on screen")
        }
        return paint(PNG.sync.read(shot), before.boxes, before.clip ?? undefined)
      } catch (error) {
        // Said as asked (it won't change); anything else (a navigation, a re-render): a try.
        if (error instanceof LookRefusal) throw error
        opts.signal?.throwIfAborted()
        last = error
      }
    }
    throw last
  } finally {
    // Never awaited: a busy page would hold a stopped look.
    void session.detach().catch(() => undefined)
  }
}

/** One scan: what to paint over, which documents were read, the measured box. */
interface Scan {
  boxes: Box[]
  documents: string[]
  clip: Box | null | undefined
}

async function scanFor(
  page: Page,
  session: CDPSession,
  matcher: RegExp | undefined,
  opts: { selectors?: readonly string[]; measure?: () => Promise<Box | null> },
  deadline: number,
): Promise<Scan> {
  const snapshot = await bounded(page, session, deadline)
  const { boxes, documents } = masksIn(snapshot, matcher)
  // The page's own document first (the snapshot's main document must be the page's main frame).
  const tree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } }
  if (documents[0]?.split("\n")[0] !== tree.frameTree.frame.id) {
    throw new Error("the snapshot isn't of the page's main frame")
  }
  for (const handle of await liveWritten(page)) {
    const box = await handle.boundingBox().catch(() => null)
    if (box !== null) boxes.push(box)
  }
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue
    for (const selector of opts.selectors ?? []) {
      try {
        for (const el of await frame.locator(selector).all()) {
          const box = await el.boundingBox({ timeout: 1000 })
          if (box !== null) boxes.push(box)
        }
      } catch (error) {
        // The main frame's rule unusable: said (it won't change). A frame's: masked whole.
        if (frame === page.mainFrame()) {
          const parse = await page
            .locator(selector)
            .count()
            .then(() => true)
            .catch(() => false)
          if (!parse) {
            throw new LookRefusal(
              `the project's redaction selector ${JSON.stringify(selector)} can't be used`,
            )
          }
          throw error
        }
        const box = await (await frame.frameElement()).boundingBox().catch(() => null)
        if (box === null) throw error
        boxes.push(box)
      }
    }
  }
  const clip = opts.measure === undefined ? undefined : await opts.measure()
  return { boxes: boxes.sort((a, b) => a.y - b.y || a.x - b.x), documents, clip }
}

/** A step of a look, given up at once when the run is stopped (its work left to finish alone). */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason as Error)
    signal.addEventListener("abort", stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop))
  })
}

/** The page's snapshot, bounded by the look's deadline; never two queued on a hung page. */
async function bounded(page: Page, session: CDPSession, deadline: number): Promise<Snapshot> {
  if (pending.has(page)) throw new Error("the page is still busy with the last look")
  const read = session.send("DOMSnapshot.captureSnapshot", {
    computedStyles: [],
  }) as Promise<Snapshot>
  pending.set(page, read)
  void read.then(
    () => pending.delete(page),
    () => pending.delete(page),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("the page didn't answer in time")),
          Math.max(1, deadline - Date.now()),
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// ── The snapshot (CDP DOMSnapshot.captureSnapshot) ───────────────────────────────────────────────

export interface Rare<T> {
  index: number[]
  value: T[]
}

export interface SnapshotDocument {
  documentURL: number
  frameId: number
  scrollOffsetX?: number
  scrollOffsetY?: number
  nodes: {
    parentIndex?: number[]
    nodeType?: number[]
    nodeName?: number[]
    nodeValue?: number[]
    attributes?: number[][]
    inputValue?: Rare<number>
    textValue?: Rare<number>
    contentDocumentIndex?: Rare<number>
    backendNodeId?: number[]
  }
  layout: { nodeIndex: number[]; bounds: number[][]; text: number[] }
  textBoxes: { layoutIndex: number[]; bounds: number[][]; start: number[]; length: number[] }
}

export interface Snapshot {
  documents: SnapshotDocument[]
  strings: string[]
}

/**
 * What to paint over (viewport CSS pixels), from one snapshot, and the documents it read (each its
 * frame id and URL: two scans of different documents never agree).
 */
export function masksIn(
  snapshot: Snapshot,
  matcher: RegExp | undefined,
): { boxes: Box[]; documents: string[] } {
  const { documents, strings } = snapshot
  const str = (i: number | undefined) => (i === undefined || i < 0 ? "" : (strings[i] ?? ""))
  // Each child document's owner element: (its parent document, its node).
  const ownerOf = new Map<number, { doc: number; node: number }>()
  for (const [d, doc] of documents.entries()) {
    const rare = doc.nodes.contentDocumentIndex
    for (const [k, node] of (rare?.index ?? []).entries()) {
      ownerOf.set(rare!.value[k]!, { doc: d, node })
    }
  }
  const boxes: Box[] = []
  const main = documents[0]
  if (main === undefined) throw new Error("the snapshot has no document")
  const toViewport = (b: number[]): Box => ({
    x: (b[0] ?? 0) - (main.scrollOffsetX ?? 0),
    y: (b[1] ?? 0) - (main.scrollOffsetY ?? 0),
    width: b[2] ?? 0,
    height: b[3] ?? 0,
  })
  // A node's layout box in its document, or its nearest ancestor's that has one.
  const layouts = new Map<SnapshotDocument, (node: number) => number[] | undefined>()
  const layoutOf = (doc: SnapshotDocument) => {
    const known = layouts.get(doc)
    if (known !== undefined) return known
    const byNode = new Map<number, number[]>()
    for (const [l, node] of doc.layout.nodeIndex.entries()) {
      if (!byNode.has(node)) byNode.set(node, doc.layout.bounds[l] ?? [])
    }
    const of = (node: number): number[] | undefined => {
      for (let n: number | undefined = node; n !== undefined && n >= 0;) {
        const b = byNode.get(n)
        if (b !== undefined && (b[2] ?? 0) > 0 && (b[3] ?? 0) > 0) return b
        n = doc.nodes.parentIndex?.[n]
      }
      return undefined
    }
    layouts.set(doc, of)
    return of
  }
  // The outermost owner in the main document of a child document's node (a frame inside a frame).
  const outermost = (d: number): number[] | undefined => {
    let at = ownerOf.get(d)
    while (at !== undefined && at.doc !== 0) at = ownerOf.get(at.doc)
    return at === undefined ? undefined : layoutOf(main)(at.node)
  }
  for (const [d, doc] of documents.entries()) {
    const found: number[][] = []
    const layout = layoutOf(doc)
    const names = doc.nodes.nodeName ?? []
    // A node with no box of its own is painted only inside a select (its options): elsewhere it
    // isn't shown (display: none), and its ancestor's box would mask a whole region for nothing.
    const ownBox = new Set(doc.layout.nodeIndex)
    const inSelect = (node: number) => {
      for (let n = doc.nodes.parentIndex?.[node]; n !== undefined && n >= 0;) {
        if (str(names[n]).toUpperCase() === "SELECT") return true
        n = doc.nodes.parentIndex?.[n]
      }
      return false
    }
    const shownBox = (node: number) =>
      ownBox.has(node) || inSelect(node) ? layout(node) : undefined
    const boxesOfLayout = new Map<number, number[]>()
    for (const [i, li] of doc.textBoxes.layoutIndex.entries()) {
      const list = boxesOfLayout.get(li)
      if (list === undefined) boxesOfLayout.set(li, [i])
      else list.push(i)
    }
    const owners = new Set(doc.nodes.contentDocumentIndex?.index ?? [])
    const attrsOf = (node: number) => {
      const flat = doc.nodes.attributes?.[node] ?? []
      const out = new Map<string, string>()
      for (let i = 0; i + 1 < flat.length; i += 2)
        out.set(str(flat[i]).toLowerCase(), str(flat[i + 1]))
      return out
    }
    const matches = (text: string) =>
      matcher !== undefined && text !== "" && matchAll(matcher, text).length > 0

    // 1. The text as laid out: each layout text whole, in layout order; a match's boxes.
    const pieces: { from: number; to: number; layout: number }[] = []
    let joined = ""
    for (const [l, t] of doc.layout.text.entries()) {
      const text = str(t)
      if (text === "") continue
      pieces.push({ from: joined.length, to: joined.length + text.length, layout: l })
      joined += text
    }
    if (matcher !== undefined) {
      for (const [at, end] of matchAll(matcher, joined)) {
        for (const p of pieces) {
          if (p.to <= at || p.from >= end) continue
          const own = boxesOfLayout.get(p.layout) ?? []
          const s = at - p.from
          const e = end - p.from
          const hit = own.filter((i) => {
            const bs = doc.textBoxes.start[i] ?? 0
            return bs < e && bs + (doc.textBoxes.length[i] ?? 0) > s
          })
          // A box touched in part: whole; none (collapsed text): the layout object's own box.
          const use = hit.length > 0 ? hit : own
          for (const i of use) found.push(doc.textBoxes.bounds[i] ?? [])
          if (use.length === 0) found.push(doc.layout.bounds[p.layout] ?? [])
        }
      }
    }

    // 2. The page's text nodes (a safety net: what layout text misses, a select's options):
    // a match masks each touched node's box, or its nearest ancestor's.
    const texts: { from: number; to: number; node: number }[] = []
    let dom = ""
    for (const [n, type] of (doc.nodes.nodeType ?? []).entries()) {
      if (type !== 3) continue
      const parent = doc.nodes.parentIndex?.[n] ?? -1
      if (parent >= 0 && UNPAINTED.has(str(names[parent]).toUpperCase())) continue
      const text = str(doc.nodes.nodeValue?.[n])
      if (text === "") continue
      texts.push({ from: dom.length, to: dom.length + text.length, node: n })
      dom += text
    }
    if (matcher !== undefined) {
      for (const [at, end] of matchAll(matcher, dom)) {
        for (const t of texts) {
          if (t.to <= at || t.from >= end) continue
          const b = shownBox(t.node)
          if (b !== undefined) found.push(b)
        }
      }
    }

    // 3. Form controls: what they paint that isn't layout text. Never a password field's value.
    const rareValue = (rare: Rare<number> | undefined) => {
      const m = new Map<number, string>()
      for (const [k, node] of (rare?.index ?? []).entries()) m.set(node, str(rare!.value[k]))
      return m
    }
    const inputValues = rareValue(doc.nodes.inputValue)
    const textValues = rareValue(doc.nodes.textValue)
    for (const [n, nameIndex] of names.entries()) {
      const name = str(nameIndex).toUpperCase()
      const attrs = attrsOf(n)
      const type = (attrs.get("type") ?? "").toLowerCase()
      const shown: string[] = []
      if (name === "INPUT" && type !== "password" && type !== "hidden") {
        shown.push(inputValues.get(n) ?? "", attrs.get("placeholder") ?? "")
        if (["button", "submit", "reset"].includes(type)) shown.push(attrs.get("value") ?? "")
      } else if (name === "TEXTAREA") {
        shown.push(textValues.get(n) ?? inputValues.get(n) ?? "", attrs.get("placeholder") ?? "")
      } else if (name === "OPTION" || name === "OPTGROUP") {
        shown.push(attrs.get("label") ?? "")
      } else if (name === "IMG" || (name === "INPUT" && type === "image")) {
        shown.push(attrs.get("alt") ?? "")
      }
      if (shown.some(matches)) {
        const b = shownBox(n)
        if (b !== undefined) found.push(b)
      }
      // 4. A frame owner whose document the snapshot hasn't (out of process): whole.
      if (FRAME_OWNERS.has(name) && !owners.has(n)) {
        const b = shownBox(n)
        if (b !== undefined) found.push(b)
      }
    }

    // The main document's boxes as they are; a child document's: its outermost frame, whole.
    if (d === 0) {
      for (const b of found) if ((b[2] ?? 0) > 0 && (b[3] ?? 0) > 0) boxes.push(toViewport(b))
    } else if (found.length > 0) {
      const b = outermost(d)
      if (b !== undefined) boxes.push(toViewport(b))
    }
  }
  return {
    boxes,
    documents: documents.map((doc) => `${str(doc.frameId)}\n${str(doc.documentURL)}`),
  }
}

/** Every match of a global pattern: its [start, end). */
function matchAll(pattern: RegExp, text: string): [number, number][] {
  return [...text.matchAll(pattern)].map((m) => [m.index, m.index + m[0].length])
}

/** Two scans the same: documents, masks within a pixel, the measured box. */
function sameScan(a: Scan, b: Scan): boolean {
  const near = (x: Box, y: Box) =>
    Math.abs(x.x - y.x) <= 1 &&
    Math.abs(x.y - y.y) <= 1 &&
    Math.abs(x.width - y.width) <= 1 &&
    Math.abs(x.height - y.height) <= 1
  if (a.documents.join("\n\n") !== b.documents.join("\n\n")) return false
  if (a.boxes.length !== b.boxes.length || !a.boxes.every((box, i) => near(box, b.boxes[i]!))) {
    return false
  }
  if ((a.clip ?? null) === null || (b.clip ?? null) === null) return a.clip === b.clip
  return near(a.clip!, b.clip!)
}

/** The boxes painted over (grown 2 px: anti-aliased edges), then the image cut to `clip`. */
function paint(png: PNG, boxes: Box[], clip: Box | undefined): MaskedShot {
  // What the image shows: the clip's box (within the viewport), else the whole.
  const cx1 = clip === undefined ? 0 : Math.max(0, Math.floor(clip.x))
  const cy1 = clip === undefined ? 0 : Math.max(0, Math.floor(clip.y))
  const cx2 = clip === undefined ? png.width : Math.min(png.width, Math.ceil(clip.x + clip.width))
  const cy2 =
    clip === undefined ? png.height : Math.min(png.height, Math.ceil(clip.y + clip.height))
  if (cx2 <= cx1 || cy2 <= cy1) throw new LookRefusal("the element isn't on screen")
  let area = 0
  for (const box of boxes) {
    const x1 = Math.max(0, Math.floor(box.x - 2))
    const y1 = Math.max(0, Math.floor(box.y - 2))
    const x2 = Math.min(png.width, Math.ceil(box.x + box.width + 2))
    const y2 = Math.min(png.height, Math.ceil(box.y + box.height + 2))
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const i = (y * png.width + x) * 4
        png.data[i] = 40
        png.data[i + 1] = 40
        png.data[i + 2] = 40
        png.data[i + 3] = 255
      }
    }
    area +=
      Math.max(0, Math.min(x2, cx2) - Math.max(x1, cx1)) *
      Math.max(0, Math.min(y2, cy2) - Math.max(y1, cy1))
  }
  let out = png
  if (clip !== undefined) {
    out = new PNG({ width: cx2 - cx1, height: cy2 - cy1 })
    PNG.bitblt(png, out, cx1, cy1, cx2 - cx1, cy2 - cy1, 0, 0)
  }
  return {
    png: PNG.sync.write(out),
    width: out.width,
    height: out.height,
    masked: Math.min(1, area / (out.width * out.height)),
  }
}
