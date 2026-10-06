import type { JSHandle, Locator } from "playwright"
import { StepError, type StepRef } from "../errors.ts"
import { type Box, planPath, type Point, seededRandom } from "../motion.ts"
import { EXACT_NAMES_HINT, knownValuesOf, refreshExactNames } from "../secret-state.ts"
import { viewportOf } from "../targets.ts"
import {
  type JoinedText,
  joinPieces,
  normalizeText,
  type Passage,
  passages,
  showsKnownValue,
  type TextPosition,
  unitAt,
} from "../text-match.ts"
import { type Ctx, guard, seedOf } from "./context.ts"
import { evenPath, travel } from "./pointer.ts"

// Selecting a passage of text with the pointer, as a reader does: press before its first
// character, drag to after its last, release; then check what the browser selected. The design
// (reviewed): the target's text as rendered, matched in Node; refusals the page can show (a link,
// a control, something clickable, a field in the passage); the passage scrolled into view in each
// of its scrollers; press and release points verified by where the browser's caret lands there.

/** Where a caret landed: a reader-text position, in a text field, or nowhere usable. */
type CaretAt = { piece: number; offset: number } | { field: true } | { none: true }
/** A point to press or release at, and where the caret lands there. */
interface Candidate extends Point {
  caret: CaretAt
}
/** Press and release candidates, the passage's box, and the box the held pointer stays in. */
interface Points {
  box: Box
  clamp: Box
  start: Candidate[]
  end: Candidate[]
}
type Placed =
  | ({ ok: true } & Points)
  | { ok: false; reason: "target-not-found" | "action-failed"; error: string }
  | { ok: false; changed: true }
/** The passage: its first and last characters (positions in the reader text's pieces). */
interface Span {
  start: TextPosition
  end: TextPosition
}

/** The page side, one object so its helpers are shared (functions run in the page). */
interface PageLib {
  read(): { pieces: string[]; breaks: boolean[] }
  place(span: Span): Promise<Placed>
  points(span: Span): Points | { error: string }
  caretAt(p: Point): CaretAt
  clearSelectionAt(p: Point): void
  selected(): string
}

/** Builds the page side for one target. Runs in the page. */
function pageLib(root: Element): PageLib {
  const nodes: Text[] = []
  const datas: string[] = []
  const breaks: boolean[] = []
  // ── The flat tree: a slot's assigned nodes, a shadow root's host ──
  const flatParent = (n: Node): Node | null =>
    (n as Element | Text).assignedSlot ??
    (n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode)
  const flatAncestors = (n: Node): Element[] => {
    const out: Element[] = []
    for (let p = flatParent(n); p !== null; p = flatParent(p)) if (p instanceof Element) out.push(p)
    return out
  }
  /** The element a node renders in (a slot for slotted content, a host for a shadow root's). */
  const flatElementParent = (n: Node): Element | null => {
    let p = flatParent(n)
    while (p !== null && !(p instanceof Element)) p = flatParent(p)
    return p
  }
  const flatClosest = (n: Node, selector: string): Element | undefined =>
    (n instanceof Element && n.matches(selector) ? n : undefined) ??
    flatAncestors(n).find((e) => e.matches(selector))
  const children = (n: Node): Node[] => {
    if (n instanceof HTMLSlotElement) {
      const shown = n.assignedNodes({ flatten: true })
      return shown.length > 0 ? shown : [...n.childNodes]
    }
    if (n instanceof Element && n.shadowRoot !== null) return [...n.shadowRoot.childNodes]
    return [...n.childNodes]
  }
  // ── The reader text ──
  const SKIP = "script, style, noscript, template, input, textarea, select, option"
  /** Rendered: its nearest ancestor with a box is visible, and so is it (`visibility`). */
  const shown = (parent: Element): boolean => {
    let boxed: Element | undefined = parent
    while (boxed !== undefined && getComputedStyle(boxed).display === "contents") {
      boxed = flatAncestors(boxed)[0]
    }
    return (
      boxed !== undefined &&
      boxed.checkVisibility({ visibilityProperty: true }) &&
      getComputedStyle(parent).visibility === "visible"
    )
  }
  const hasBox = (t: Text): boolean => {
    const r = document.createRange()
    r.selectNodeContents(t)
    return [...r.getClientRects()].some((b) => b.width > 0 && b.height > 0)
  }
  let pending = false
  const visit = (n: Node) => {
    if (n instanceof Text) {
      const parent = flatElementParent(n)
      if (n.data === "" || parent === null || !shown(parent)) return
      // Whitespace at a soft wrap may have no box: still a separator.
      if (n.data.trim() !== "" && !hasBox(n)) return
      nodes.push(n)
      datas.push(n.data)
      breaks.push(pending)
      pending = false
      return
    }
    if (n instanceof Element) {
      if (n.matches(SKIP)) return
      if (n.tagName === "BR") {
        pending = true
        return
      }
      const d = getComputedStyle(n).display
      if (d === "none" || d === "ruby-text") return
      // A line: its edges separate words (an inline-block runs on with the text beside it, as the
      // browser's own selection text does).
      const edge = d !== "contents" && !d.startsWith("inline")
      if (edge) pending = true
      for (const c of children(n)) visit(c)
      if (edge) pending = true
      return
    }
    for (const c of children(n)) visit(c)
  }
  // ── Geometry ──
  const plain = (r: DOMRect): Box => ({ x: r.x, y: r.y, width: r.width, height: r.height })
  const rangeOf = ({ start, end }: Span): Range => {
    const r = document.createRange()
    r.setStart(nodes[start.piece] as Text, start.offset)
    r.setEnd(nodes[end.piece] as Text, end.offset + end.length)
    return r
  }
  const charRect = (p: TextPosition, which: "first" | "last"): DOMRect | undefined => {
    const r = document.createRange()
    r.setStart(nodes[p.piece] as Text, p.offset)
    r.setEnd(nodes[p.piece] as Text, p.offset + p.length)
    const rects = [...r.getClientRects()].filter((b) => b.width > 0 && b.height > 0)
    return which === "first" ? rects[0] : rects.at(-1)
  }
  const scrollable = (e: Element): boolean => {
    const s = getComputedStyle(e)
    const y = /(auto|scroll|overlay)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 1
    const x = /(auto|scroll|overlay)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1
    return y || x
  }
  /** A scroller's padding box (scrollbars out), where it shows its content. */
  const paddingBox = (e: Element): Box => {
    const r = e.getBoundingClientRect()
    return {
      x: r.left + e.clientLeft,
      y: r.top + e.clientTop,
      width: e.clientWidth,
      height: e.clientHeight,
    }
  }
  /** A scroller's visible box (its padding box, scrollbars out), within the viewport. */
  const visibleBox = (e: Element | undefined): Box => {
    const view = { x: 0, y: 0, width: innerWidth, height: innerHeight }
    if (e === undefined) return view
    const r = e.getBoundingClientRect()
    const x = Math.max(0, r.left + e.clientLeft)
    const y = Math.max(0, r.top + e.clientTop)
    return {
      x,
      y,
      width: Math.min(innerWidth, r.left + e.clientLeft + e.clientWidth) - x,
      height: Math.min(innerHeight, r.top + e.clientTop + e.clientHeight) - y,
    }
  }
  const within = (r: DOMRect, b: Box) =>
    r.top >= b.y - 0.5 &&
    r.left >= b.x - 0.5 &&
    r.bottom <= b.y + b.height + 0.5 &&
    r.right <= b.x + b.width + 0.5
  const shadowRoots = (n: Node): ShadowRoot[] => {
    const roots: ShadowRoot[] = []
    for (let p: Node | null = n; p !== null; p = flatParent(p)) {
      const root = p.getRootNode()
      if (root instanceof ShadowRoot && !roots.includes(root)) roots.push(root)
    }
    return roots
  }
  /** Every open shadow root a reader node is in (or above), for the caret and the selection. */
  const allRoots = (): ShadowRoot[] => {
    const roots: ShadowRoot[] = []
    for (const n of nodes) for (const r of shadowRoots(n)) if (!roots.includes(r)) roots.push(r)
    return roots
  }
  const twoFrames = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      setTimeout(resolve, 500)
    })
  /**
   * Where the browser's caret lands at a point, shadow roots included (Chromium 128+); none
   * without the API (fails closed: nothing is pressed unverified).
   */
  const caretPosition = (p: Point): { offsetNode: Node; offset: number } | null => {
    const doc = document as Document & {
      caretPositionFromPoint?: (
        x: number,
        y: number,
        options?: { shadowRoots: ShadowRoot[] },
      ) => { offsetNode: Node; offset: number } | null
    }
    return doc.caretPositionFromPoint?.(p.x, p.y, { shadowRoots: roots }) ?? null
  }
  /** Each reader node's index, and the shadow roots they're in: read once. */
  const index = new Map<Text, number>()
  let roots: ShadowRoot[] = []
  /** The passage's scrollers, innermost first (set when it's placed; the page's own is apart). */
  let scrollers: Element[] = []
  const rootStyle = getComputedStyle(document.documentElement)
  /** The body's overflow is the viewport's (not its own) while the root's overflow is visible. */
  const bodyIsViewport = rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible"
  const scrollersOf = (n: Node) =>
    flatAncestors(n).filter(
      (e) =>
        e !== document.scrollingElement &&
        !(e === document.body && bodyIsViewport) &&
        scrollable(e),
    )
  const lib: PageLib = {
    read() {
      visit(root)
      breaks[0] = false
      nodes.forEach((n, i) => index.set(n, i))
      roots = allRoots()
      return { pieces: [...datas], breaks: [...breaks] }
    },
    async place(span) {
      const first = nodes[span.start.piece] as Text
      const last = nodes[span.end.piece] as Text
      if (first.getRootNode() !== last.getRootNode()) {
        return {
          ok: false,
          reason: "action-failed",
          error:
            "the passage crosses a component's edge (a selection can't): select a part within one",
        }
      }
      const range = rangeOf(span)
      if (range.collapsed) {
        return {
          ok: false,
          reason: "action-failed",
          error:
            "the passage is shown in another order than the page holds it (a component rearranges its content): select a part within one element",
        }
      }
      const common = range.commonAncestorContainer
      const holder =
        common instanceof Element
          ? common
          : common instanceof ShadowRoot
            ? common.host
            : (flatParent(common) as Element)
      const refuse = (error: string): Placed => ({ ok: false, reason: "action-failed", error })
      // A field or an editable region inside the passage (a value would be in the selection).
      const fields = (
        common instanceof Element || common instanceof ShadowRoot ? common : holder
      ).querySelectorAll("input, textarea, select, [contenteditable]:not([contenteditable=false])")
      if ([...fields].some((f) => range.intersectsNode(f))) {
        return refuse("the passage holds a form field or an editable region: select text around it")
      }
      // The click a release sends goes to what holds both ends; a press acts on what's under it
      // (a link or a draggable drags, a control may act on mousedown).
      const clickable =
        "a[href], button, label, summary, select, [onclick], [role=button], [role=link], [role=tab], [role=option], [role^=menuitem], [role=checkbox], [role=radio], [role=switch], [role=treeitem]"
      const acts = (e: Element) =>
        e.matches(`${clickable}, [draggable=true]`) || getComputedStyle(e).cursor === "pointer"
      const pressed = flatElementParent(first) as Element
      const underPress = [pressed, ...flatAncestors(pressed)]
      const belowHolder = underPress.slice(0, Math.max(0, underPress.indexOf(holder)))
      if (belowHolder.some(acts)) {
        return refuse(
          "the passage starts inside a link or a control (a press there drags or activates it): start it before or after",
        )
      }
      // A release on an option or a menu item picks it.
      if (flatClosest(last, "select, [role=option], [role^=menuitem]")) {
        return refuse(
          "the passage ends inside an option or a menu item (the release would pick it)",
        )
      }
      for (const e of [holder, ...flatAncestors(holder)]) {
        if (e === document.body || e === document.documentElement) break
        if (acts(e)) {
          return refuse(
            "the passage is inside something clickable (the release would click it): select text outside it",
          )
        }
      }
      if (flatClosest(first, "[inert]")) {
        return refuse("the passage is behind a dialog (inert): close the dialog first")
      }
      for (const n of [first, last]) {
        const parent = flatElementParent(n) as Element
        const style = getComputedStyle(parent)
        const select = style.userSelect || style.webkitUserSelect
        if (select === "none") {
          return refuse(
            "nothing can be selected there: the page doesn't let its text be selected (user-select: none)",
          )
        }
        if (select === "all") {
          // The element a press selects whole: the outermost one (user-select is inherited).
          let all: Element = parent
          for (const a of flatAncestors(parent)) {
            const st = getComputedStyle(a)
            if ((st.userSelect || st.webkitUserSelect) !== "all") break
            all = a
          }
          const whole = document.createRange()
          whole.selectNodeContents(all)
          // Page text against page text (never the agent's words).
          const flat = (r: Range) => r.toString().replace(/\s+/g, " ").trim()
          const covers = flat(range) === flat(whole)
          if (!covers) {
            return refuse(
              "that text is selected whole on a press (user-select: all): select all of it",
            )
          }
        }
      }
      // On screen: in each scroller around it, innermost first, then the page; instantly (CSS
      // smooth scrolling would leave it mid-way).
      scrollers = scrollersOf(first)
      for (const e of scrollers) {
        const r = range.getBoundingClientRect()
        // Its own padding box: a pane below the fold is still where its content goes.
        const b = paddingBox(e)
        if (within(r, b)) continue
        const dy = r.top + r.height / 2 - (b.y + b.height / 2)
        const dx =
          r.left >= b.x && r.right <= b.x + b.width ? 0 : r.left + r.width / 2 - (b.x + b.width / 2)
        e.scrollTo({ top: e.scrollTop + dy, left: e.scrollLeft + dx, behavior: "instant" })
      }
      const page = document.scrollingElement
      const r = range.getBoundingClientRect()
      if (page !== null && !within(r, visibleBox(undefined))) {
        const sideways =
          r.left >= 0 && r.right <= innerWidth ? 0 : r.left + r.width / 2 - innerWidth / 2
        page.scrollTo({
          top: page.scrollTop + r.top + r.height / 2 - innerHeight / 2,
          left: page.scrollLeft + sideways,
          behavior: "instant",
        })
      }
      // A list that re-renders as it scrolls (virtualized, lazy; also after the scroll that found
      // the target): read and matched again from scratch.
      await twoFrames()
      if (nodes.some((n, i) => !n.isConnected || n.data !== datas[i])) {
        return { ok: false, changed: true }
      }
      const placed = lib.points(span)
      if ("error" in placed) return { ok: false, reason: "target-not-found", error: placed.error }
      return { ok: true, ...placed }
    },
    points(span) {
      const range = rangeOf(span)
      const box = range.getBoundingClientRect()
      const clamp = scrollers.reduce((b, e) => {
        const v = visibleBox(e)
        const x = Math.max(b.x, v.x)
        const y = Math.max(b.y, v.y)
        return {
          x,
          y,
          width: Math.min(b.x + b.width, v.x + v.width) - x,
          height: Math.min(b.y + b.height, v.y + v.height) - y,
        }
      }, visibleBox(undefined))
      if (!within(box, clamp)) {
        return {
          error:
            "the passage doesn't fit on screen (or couldn't be scrolled there): select a shorter one, or scroll to it first",
        }
      }
      const firstChar = charRect(span.start, "first")
      const lastChar = charRect(span.end, "last")
      if (firstChar === undefined || lastChar === undefined) {
        return { error: "the passage has no box on the page" }
      }
      // A quarter and three quarters across each character: its two halves (the caret goes
      // before or after it, in either writing direction).
      const at = (r: DOMRect): Candidate[] =>
        [0.25, 0.75].map((f) => {
          const p = { x: r.left + r.width * f, y: r.top + r.height / 2 }
          return { ...p, caret: lib.caretAt(p) }
        })
      return { box: plain(box), clamp, start: at(firstChar), end: at(lastChar) }
    },
    caretAt(p) {
      const pos = caretPosition(p)
      if (pos === null) return { none: true }
      const node = pos.offsetNode
      if (flatClosest(node, "input, textarea")) return { field: true }
      const piece = index.get(node as Text)
      if (piece !== undefined) return { piece, offset: pos.offset }
      // Elsewhere (between nodes, or on a text that isn't read): the first reader node at or after
      // it, if it's inside what the caret landed in (else the point is on something on top: a
      // header, a banner).
      const caret = document.createRange()
      try {
        caret.setStart(node, pos.offset)
      } catch {
        return { none: true }
      }
      // Nodes of another tree (a shadow root's, slotted ones) can't be compared: never "after".
      const after = (n: Text) => {
        try {
          return caret.comparePoint(n, 0) >= 0
        } catch {
          return false
        }
      }
      const next = nodes.findIndex(after)
      if (next === -1) {
        // Past the last reader node: the target's end, if the caret is still in the target (else
        // on something on top, later in the page: a footer, a cookie banner).
        const inTarget = node === root || flatAncestors(node).includes(root)
        return inTarget ? { piece: nodes.length, offset: 0 } : { none: true }
      }
      const inside = (n: Node) => n === node || flatAncestors(n).includes(node as Element)
      return inside(nodes[next] as Text) ? { piece: next, offset: 0 } : { none: true }
    },
    clearSelectionAt(p) {
      // A press inside a selection drags the selected text (an editor would move it): cleared
      // first, never made. The document's selection, and each web component's.
      const caret = caretPosition(p)
      const selections = [
        getSelection(),
        ...roots.map((r) =>
          (r as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.(),
        ),
      ]
      for (const sel of selections) {
        if (sel == null || sel.isCollapsed || sel.rangeCount === 0) continue
        const inside = (() => {
          try {
            return caret != null && sel.getRangeAt(0).isPointInRange(caret.offsetNode, caret.offset)
          } catch {
            return false
          }
        })()
        if (caret == null || inside) sel.removeAllRanges()
      }
    },
    selected() {
      const text = getSelection()?.toString() ?? ""
      if (text !== "") return text
      // A selection inside a web component (Chromium keeps it on its shadow root).
      for (const r of roots) {
        const inner = (r as ShadowRoot & { getSelection?: () => Selection | null })
          .getSelection?.()
          ?.toString()
        if (inner !== undefined && inner !== "") return inner
      }
      return ""
    },
  }
  return lib
}

/** The one "not there" message, whatever the reason (a field's value, a masked secret, absent). */
const NOT_THERE =
  "the target's text doesn't hold that passage (as shown: case, dashes, quotes and spaces don't matter): snapshot with `find` to see where it is"

/** Selects `text` within the target with the pointer, then checks the browser selected it. */
export async function selectText(
  ctx: Ctx,
  target: Locator,
  text: string,
  step: StepRef,
): Promise<void> {
  const needle = normalizeText(text)
  // §3 A8: while a field holding a secret is on the page, a passage is a whole element's text: the
  // only comparison is the needle against the target's whole text (a whole-value guess).
  const before = await refreshExactNames(ctx.page)
  for (let attempt = 0; ; attempt++) {
    const lib: JSHandle<PageLib> = await guard(step, () =>
      target.evaluateHandle(pageLib, undefined, { timeout: ctx.timeoutMs }),
    )
    try {
      const { pieces, breaks } = await guard(step, () => lib.evaluate((l) => l.read()))
      // Matched in Node (the page never sees what's looked for).
      const joined = joinPieces(pieces, breaks)
      const after = await refreshExactNames(ctx.page)
      const known = knownValuesOf(ctx.page.context())
      // The same refusal whether the text shows a known value or the guess is wrong: the whole
      // text is compared only when it shows none.
      if (
        (before.exact || after.exact) &&
        (showsKnownValue(joined, known) || joined.text !== needle)
      ) {
        throw new StepError(
          step,
          "secret-refused",
          `only an element's whole text can be selected while a field holding a secret is on the page: target the element that holds just the passage${EXACT_NAMES_HINT}`,
        )
      }
      const at = passages(joined, needle, known)
      if (at.length === 0) throw new StepError(step, "target-not-found", NOT_THERE)
      if (at.length > 1) {
        throw new StepError(
          step,
          "target-ambiguous",
          `the passage appears ${at.length} times in the target: target the element that holds it once (its paragraph), or select a longer passage`,
        )
      }
      const passage = at[0] as Passage
      const span: Span = {
        start: joined.from[passage.begin] as TextPosition,
        end: joined.from[passage.end - 1] as TextPosition,
      }
      // The page's own text of it (spaces as the page has them, when matched spaces aside).
      const expected = joined.text.slice(passage.begin, passage.end)
      const placed = await guard(step, () => lib.evaluate((l, s) => l.place(s), span))
      if (!placed.ok && "changed" in placed) {
        if (attempt === 0) continue
        throw new StepError(
          step,
          "target-not-found",
          "the page changed as it scrolled to the passage: try again",
        )
      }
      if (!placed.ok) throw new StepError(step, placed.reason, placed.error)
      await drawSelection(ctx, step, lib, joined, span, passage, placed)
      const selected = await guard(step, () => lib.evaluate((l) => l.selected()))
      // What the browser selected, compared here; never said (it may hold a field's value).
      if (normalizeText(selected) !== expected) {
        throw new StepError(
          step,
          "action-failed",
          selected.trim() === ""
            ? "nothing got selected: the page doesn't let its text be selected there (an app that draws its own selection, or text on a canvas)"
            : "the browser selected something else: the text may be in pieces the pointer can't drag across",
        )
      }
      return
    } finally {
      await lib.dispose().catch(() => undefined)
    }
  }
}

/**
 * The gesture: travel to the verified press point, press, drag with the button held (within the
 * passage's scroller: never off its edge, where the browser would autoscroll) to the verified
 * release point, release.
 */
async function drawSelection(
  ctx: Ctx,
  step: StepRef,
  lib: JSHandle<PageLib>,
  joined: JoinedText,
  span: Span,
  units: { begin: number; end: number },
  placed: Points,
): Promise<void> {
  const lands = (c: CaretAt, unit: number) =>
    "piece" in c && unitAt(joined, c.piece, c.offset) === unit
  const pick = (points: Points, which: "start" | "end"): Candidate => {
    const unit = which === "start" ? units.begin : units.end
    const candidates = points[which]
    const hit = candidates.find((c) => lands(c.caret, unit))
    if (hit !== undefined) return hit
    throw new StepError(
      step,
      "action-failed",
      candidates.some((c) => "field" in c.caret)
        ? "the app draws its own selection here (an editor or a code view over the text)"
        : `something covers or clips the passage where the pointer would ${which === "start" ? "press" : "release"} (a header, a banner, a panel's edge): scroll it clear first`,
    )
  }
  const viewport = await viewportOf(ctx.page)
  const onCamera = step.phase === "steps" && ctx.pacing.cursor !== "instant"
  const pacing = onCamera ? ctx.pacing.cursor : "instant"
  const random = seededRandom(`${seedOf(step)}:select`)
  // The positions in use: re-measured when the page moved during the travel.
  let points = placed
  let from = pick(points, "start")
  const here = ctx.cursor ?? { x: viewport.width / 2, y: viewport.height / 2 }
  await guard(step, () =>
    travel(ctx, step, planPath(here, from, { pacing, targetWidth: 8, viewport, random })),
  )
  const caretAt = (p: Point) => guard(step, () => lib.evaluate((l, q) => l.caretAt(q), p))
  // The page may have moved while the pointer travelled (a header that hides, an image loaded).
  if (!lands(await caretAt(from), units.begin)) {
    const again = await guard(step, () => lib.evaluate((l, s) => l.points(s), span))
    if ("error" in again) throw new StepError(step, "target-not-found", again.error)
    points = again
    from = pick(points, "start")
    await guard(step, () => travel(ctx, step, evenPath(ctx.cursor ?? from, from, 3)))
    if (!lands(await caretAt(from), units.begin)) {
      throw new StepError(
        step,
        "action-failed",
        "the page kept moving under the pointer: try again once it settles",
      )
    }
  }
  // Where to release, chosen before anything is pressed (a covered end refuses with nothing done).
  const to = pick(points, "end")
  const { clamp } = points
  await guard(step, () => lib.evaluate((l, p) => l.clearSelectionAt(p), { x: from.x, y: from.y }))
  if (ctx.options.recording === true) {
    // A press for the recorder: the camera frames the passage.
    ctx.options.onEvent?.({
      kind: "click",
      step,
      x: from.x,
      y: from.y,
      box: points.box,
      button: "left",
      count: 1,
    })
  }
  await guard(step, () => ctx.page.mouse.move(from.x, from.y))
  await guard(step, () => ctx.page.mouse.down())
  ctx.options.onEvent?.({ kind: "cursor", step, x: from.x, y: from.y, pressed: true })
  let released = false
  try {
    const keep = (p: { t: number; x: number; y: number }) => ({
      t: p.t,
      x: Math.min(clamp.x + clamp.width - 1, Math.max(clamp.x + 1, p.x)),
      y: Math.min(clamp.y + clamp.height - 1, Math.max(clamp.y + 1, p.y)),
    })
    const path = planPath(from, to, { pacing, targetWidth: 8, viewport, random, overshoot: false })
    // Always several moves (instant pacing plans one): the browser extends the selection on each.
    await guard(step, () =>
      travel(ctx, step, (path.length >= 5 ? path : evenPath(from, to, 5)).map(keep), true),
    )
    // Where the release lands now (the page may have shifted): one last hop to it if needed,
    // measured again, and checked before the button goes up.
    if (!lands(await caretAt(to), units.end)) {
      const again = await guard(step, () => lib.evaluate((l, s) => l.points(s), span))
      if ("error" in again) throw new StepError(step, "target-not-found", again.error)
      const end = pick(again, "end")
      const inAgain = (p: { t: number; x: number; y: number }) => ({
        t: p.t,
        x: Math.min(again.clamp.x + again.clamp.width - 1, Math.max(again.clamp.x + 1, p.x)),
        y: Math.min(again.clamp.y + again.clamp.height - 1, Math.max(again.clamp.y + 1, p.y)),
      })
      await guard(step, () =>
        travel(ctx, step, evenPath(ctx.cursor ?? to, end, 3).map(inAgain), true),
      )
      if (!lands(await caretAt(end), units.end)) {
        throw new StepError(
          step,
          "action-failed",
          "the page kept moving under the pointer: try again once it settles",
        )
      }
    }
    await guard(step, () => ctx.page.mouse.up())
    released = true
    ctx.options.onEvent?.({ kind: "cursor", step, ...(ctx.cursor ?? to), pressed: false })
  } finally {
    // Never leave the button held (the next steps would drag).
    if (!released) await ctx.page.mouse.up().catch(() => undefined)
  }
}
