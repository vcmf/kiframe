import type { GroundedTarget, Locator as SchemaLocator, Target } from "@kiframe/schema"
import { isGrounded } from "@kiframe/schema"
import type { Locator, Page } from "playwright"

/** Builds the Playwright locator for one schema locator (roles, labels, text first; CSS last). */
export function toPlaywright(page: Page, locator: SchemaLocator): Locator {
  switch (locator.by) {
    case "role":
      return page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], {
        ...(locator.name !== undefined && { name: locator.name }),
        ...(locator.exact !== undefined && { exact: locator.exact }),
      })
    case "label":
      return page.getByLabel(locator.name, {
        ...(locator.exact !== undefined && { exact: locator.exact }),
      })
    case "text":
      return page.getByText(locator.text, {
        ...(locator.exact !== undefined && { exact: locator.exact }),
      })
    case "placeholder":
      return page.getByPlaceholder(locator.text)
    case "css":
      return page.locator(locator.selector)
  }
}

/** Short human description of a locator, for error messages. */
export function describeLocator(locator: SchemaLocator): string {
  switch (locator.by) {
    case "role":
      return `role ${locator.role}${locator.name !== undefined ? ` "${locator.name}"` : ""}`
    case "label":
      return `label "${locator.name}"`
    case "text":
      return `text "${locator.text}"`
    case "placeholder":
      return `placeholder "${locator.text}"`
    case "css":
      return `css ${locator.selector}`
  }
}

export type ResolveResult =
  | { ok: true; locator: Locator; used: SchemaLocator; fallbackIndex: number | undefined }
  | { ok: false; reason: "not-grounded" | "target-not-found" | "target-ambiguous"; detail: string }

/** Only the elements that are actually rendered: hidden duplicates (a display:none mobile menu…) don't count. */
export function visibleOnly(locator: Locator): Locator {
  return locator.filter({ visible: true })
}

/**
 * Resolves a target to exactly one visible element. Until the deadline, every round checks the
 * primary locator and then each fallback, in priority order, and takes the first one that has a
 * visible match, so a primary element that renders late still wins while time is left. Hidden matches
 * are ignored and `nth` counts visible matches only. Several visible matches are an error unless
 * `nth` picks one (never guess which).
 */
export async function resolveTarget(
  page: Page,
  target: Target,
  timeoutMs: number,
): Promise<ResolveResult> {
  if (!isGrounded(target)) {
    return {
      ok: false,
      reason: "not-grounded",
      detail: `target not grounded yet — intent "${target.intent}"`,
    }
  }
  const { fallbacks = [], nth } = target
  // `nth` belongs to the primary locator only: each fallback is its own locator.
  const candidates: { locator: SchemaLocator; nth: number | undefined }[] = [
    { locator: stripExtras(target), nth },
    ...fallbacks.map((locator) => ({ locator, nth: undefined })),
  ]
  const deadline = Date.now() + timeoutMs
  // Ambiguity can be transient (a dialog fading out while a new one fades in): keep polling and
  // only report it if it's still the state at the deadline.
  let ambiguous: string | undefined
  for (;;) {
    ambiguous = undefined
    for (const [i, candidate] of candidates.entries()) {
      const visible = visibleOnly(toPlaywright(page, candidate.locator))
      const count = await visible.count().catch((error: unknown) => {
        // A navigation (client-side redirect…) replaced the page mid-poll: retry on the new one.
        if (isNavigationError(error)) return 0
        throw error
      })
      if (count === 0 || (candidate.nth !== undefined && count <= candidate.nth)) continue
      if (candidate.nth === undefined && count > 1) {
        // Stop here: falling through to a fallback could act on a different element.
        ambiguous = `${describeLocator(candidate.locator)} matches ${count} visible elements — add \`nth\` or a more precise locator`
        break
      }
      const locator = candidate.nth === undefined ? visible : visible.nth(candidate.nth)
      return {
        ok: true,
        locator,
        used: candidate.locator,
        fallbackIndex: i === 0 ? undefined : i - 1,
      }
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (ambiguous !== undefined) return { ok: false, reason: "target-ambiguous", detail: ambiguous }
  const tried = candidates.map((c) => describeLocator(c.locator)).join(", then ")
  return { ok: false, reason: "target-not-found", detail: `target not found — tried ${tried}` }
}

/** The locator part of a grounded target, without the healing metadata. */
function stripExtras(target: GroundedTarget): SchemaLocator {
  const {
    intent: _intent,
    fallbacks: _fallbacks,
    fingerprint: _fingerprint,
    nth: _nth,
    ...locator
  } = target
  return locator
}

/**
 * True if the element is actually on screen: its center is inside the viewport and the topmost
 * element there is the element itself or one of its children. Playwright's "visible" only means
 * "has a box", which is also true when the element is scrolled out of view inside a container.
 */
export async function isOnScreen(
  page: Page,
  locator: Locator,
  timeoutMs: number,
): Promise<boolean> {
  const box = await locator.boundingBox({ timeout: timeoutMs }).catch(() => null)
  if (box === null) return false
  const viewport = await viewportOf(page)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return false
  return locator
    .evaluate(pointProbe, [x, y, false] as [number, number, boolean], { timeout: timeoutMs })
    .then((probe) => probe.hits)
    .catch(() => false)
}

/** Errors thrown when the page navigated while Playwright was querying it. */
export function isNavigationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /execution context was destroyed|frame was detached/i.test(error.message)
  )
}

/** The viewport size. Pages without a fixed viewport (CDP-connected, Electron) are asked directly. */
export async function viewportOf(page: Page): Promise<{ width: number; height: number }> {
  return (
    page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  )
}

/**
 * What's under a point, for hit tests (runs in the page, self-contained so it can be passed to
 * `evaluate`). Goes down through open shadow roots to the deepest element, then reports whether
 * it's `el` or inside it, or inside `el`'s enclosing control (Playwright accepts a hit anywhere in
 * the button a target sits in), plus everything the hit control is called (for the risky check).
 */
export function pointProbe(
  el: Element,
  [x, y, withLabel]: [number, number, boolean],
): { hits: boolean; label: string } {
  const CONTROLS =
    "button, a, input, [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=option]"
  let hit = document.elementFromPoint(x, y)
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y)
    if (inner === null || inner === hit) break
    hit = inner
  }
  const up = (n: Node): Node | null => n.parentNode ?? (n instanceof ShadowRoot ? n.host : null)
  const closest = (from: Element | null): Element | null => {
    for (let n: Node | null = from; n !== null; n = up(n))
      if (n instanceof Element && n.matches(CONTROLS)) return n
    return null
  }
  const within = (node: Node | null, ancestor: Element | null): boolean => {
    for (let n = node; n !== null; n = up(n)) if (n === ancestor) return true
    return false
  }
  const hits = hit !== null && (within(hit, el) || within(hit, closest(el)))
  if (!withLabel) return { hits, label: "" }
  // The label of what the press would actually activate: the control under the point (its text,
  // hidden text included, and every naming attribute in it), or the element itself if it's no control.
  const hitControl = closest(hit)
  const control = hitControl ?? hit
  const texts: (string | null | undefined)[] = []
  if (hitControl === null && hit !== null) {
    // Not a control (a card's background, a row's cell): the press activates the element itself,
    // not the buttons inside it, so only its own text counts, without nested controls.
    const own: string[] = []
    const walk = (node: Node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) own.push(child.textContent ?? "")
        else if (child instanceof Element && !child.matches(CONTROLS)) walk(child)
      }
    }
    walk(hit)
    texts.push(own.join(""), hit.getAttribute("aria-label"), hit.getAttribute("title"))
  } else if (control !== null) {
    const root = control.getRootNode() as Document | ShadowRoot
    texts.push(control instanceof HTMLElement ? control.innerText : null, control.textContent)
    for (const e of [control, ...control.querySelectorAll("*")]) {
      for (const attr of ["alt", "aria-label", "title"]) texts.push(e.getAttribute(attr))
      for (const id of (e.getAttribute("aria-labelledby") ?? "").split(/\s+/)) {
        if (id !== "")
          texts.push(
            root.getElementById(id)?.textContent ?? document.getElementById(id)?.textContent,
          )
      }
    }
    if (
      control instanceof HTMLInputElement &&
      ["submit", "button", "reset", "image"].includes(control.type.toLowerCase())
    ) {
      texts.push(control.value)
    }
  }
  const label = texts
    .filter((s): s is string => typeof s === "string")
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
  return { hits, label }
}
