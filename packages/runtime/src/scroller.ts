// Where a page scrolls, and where its view is: the scroll step's scroller, and what the agent is
// told of the view with each snapshot (a snapshot covers the whole page, on screen or not).
import type { Page } from "playwright"

/**
 * The page's main scroller: the document when it scrolls, otherwise the largest visible scrollable
 * element (app-shell layouts, where `<body>` doesn't scroll and a `<main>` pane does). Runs in the page.
 */
export function findMainScroller(): Element {
  const doc = document.scrollingElement ?? document.documentElement
  const docScrolls =
    doc.scrollHeight > innerHeight + 1 &&
    getComputedStyle(document.documentElement).overflowY !== "hidden" &&
    getComputedStyle(document.body).overflowY !== "hidden"
  if (docScrolls) return doc
  let best: Element = doc
  let bestArea = 0
  for (const el of document.querySelectorAll("*")) {
    const { overflowY } = getComputedStyle(el)
    if (!/(auto|scroll|overlay)/.test(overflowY) || el.scrollHeight <= el.clientHeight + 1) continue
    const r = el.getBoundingClientRect()
    const area =
      Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) *
      Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0))
    if (area > bestArea) {
      bestArea = area
      best = el
    }
  }
  return best
}

/** Where the view is in a page that scrolls: how far down (0–100), and the section it's in. */
export interface PageView {
  /** Scrolled at all (a few screens down a very long page still rounds to 0%). */
  scrolled: boolean
  percent: number
  /** The heading of the section being read, if any. */
  heading?: string
}

/**
 * The view of the page's main scroller; none when nothing scrolls. One call into the page (a busy
 * page answers each in ~300 ms: Cal.com's login).
 */
export function viewOf(page: Page): Promise<PageView | undefined> {
  return page.evaluate<PageView | undefined>(
    `(${viewIn.toString()})((${findMainScroller.toString()})())`,
  )
}

/** Where the view of `el` (a scroller) is. Runs in the page. */
function viewIn(el: Element): PageView | undefined {
  const isDocument = el === (document.scrollingElement ?? document.documentElement)
  const height = isDocument ? innerHeight : el.clientHeight
  const range = el.scrollHeight - height
  if (range <= 1) return undefined
  const top = isDocument ? 0 : el.getBoundingClientRect().top
  // The section being read: the last heading at or above the view's top third; at the page's
  // end (its last sections can't scroll that far up), the last one on screen. Else the first
  // heading on screen.
  const reading = el.scrollTop >= range - 1 ? top + height : top + height / 3
  let heading: string | undefined
  let onScreen: string | undefined
  // A heading pinned on screen (a sticky header, a fixed panel) is never the section read.
  const pinned = (h: Element) => {
    for (let a: Element | null = h; a !== null && a !== el; a = a.parentElement) {
      const { position } = getComputedStyle(a)
      if (position === "fixed" || position === "sticky") return true
    }
    return false
  }
  for (const h of el.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]")) {
    const r = h.getBoundingClientRect()
    if (r.height === 0 || pinned(h)) continue
    const text = (h.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80)
    if (text === "") continue
    if (r.top <= reading) heading = text
    else if (onScreen === undefined && r.top < top + height) onScreen = text
  }
  heading ??= onScreen
  return {
    scrolled: el.scrollTop > 0,
    percent: Math.round((el.scrollTop / range) * 100),
    ...(heading !== undefined && { heading }),
  }
}
