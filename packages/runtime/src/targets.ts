import { assertNotProbing, exactNamesFor, isPartialName } from "./secret-state.ts"
import type { GroundedTarget, Locator as SchemaLocator, Scope, Target } from "@kiframe/schema"
import { isGrounded } from "@kiframe/schema"
import type { Locator, Page } from "playwright"

/**
 * The Playwright locator for a schema locator, with the exact-names rule of the moment (SECRETS-
 * DESIGN §3 A8): refreshed now, so no caller can build one with a stale decision.
 */
export async function locatorFor(page: Page, locator: SchemaLocator): Promise<Locator> {
  return toPlaywright(page, locator, (await exactNamesFor(page, [locator])).exact)
}

/**
 * Builds the Playwright locator; `forced`: exact names (A8), decided by the caller just now;
 * `within`: the row a target is in (`scopeOf`), the locator looked for inside it.
 */
export function toPlaywright(
  page: Page,
  locator: SchemaLocator,
  forced: boolean,
  within?: Locator,
): Locator {
  const exact = (own: boolean | undefined) =>
    forced ? { exact: true } : own !== undefined ? { exact: own } : {}
  const base = within ?? page
  switch (locator.by) {
    case "role":
      // Spliced into Playwright's selector unescaped: only a role name, never selector syntax.
      if (!/^[a-z]{2,40}$/.test(locator.role)) throw new Error(`not an ARIA role: ${locator.role}`)
      return base.getByRole(locator.role as Parameters<Page["getByRole"]>[0], {
        ...(locator.name !== undefined && { name: locator.name, ...exact(locator.exact) }),
      })
    case "label":
      return base.getByLabel(locator.name, exact(locator.exact))
    case "text":
      return base.getByText(locator.text, exact(locator.exact))
    case "placeholder":
      return base.getByPlaceholder(locator.text, exact(undefined))
    case "css":
      assertNotProbing(page.context(), locator.selector)
      return base.locator(locator.selector)
  }
}

/**
 * The rows a target's `in` names: the visible elements of that role holding an element whose text
 * is exactly `has` (never a substring: no filter tells whether part of a value is on the page), the
 * innermost ones (a tree item holding a sub-item with that text isn't that row).
 */
export function scopeOf(page: Page, scope: Scope): Locator {
  // Spliced into Playwright's selector unescaped: only a role name, never selector syntax.
  if (!/^[a-z]{2,40}$/.test(scope.role)) throw new Error(`not an ARIA role: ${scope.role}`)
  const role = scope.role as Parameters<Page["getByRole"]>[0]
  const holding = page.getByRole(role).filter({ has: page.getByText(scope.has, { exact: true }) })
  return visibleOnly(holding.filter({ hasNot: holding }))
}

/** A row as messages say it. */
export function describeScope(scope: Scope): string {
  return `the ${scope.role} holding "${scope.has}"`
}

/**
 * The one row a target's `in` names, or why not: none (yet), or several (a row must say which one:
 * never the first of them).
 */
export async function rowOf(
  page: Page,
  scope: Scope,
): Promise<{ row: Locator } | { count: number | undefined }> {
  const rows = scopeOf(page, scope)
  const count = await rows.count().catch((error: unknown) => {
    if (isNavigationError(error)) return undefined
    throw error
  })
  return count === 1 ? { row: rows } : { count }
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

/** `exact`: whether names were matched exactly at the last poll (SECRETS-DESIGN §3 A8). */
export type ResolveResult =
  | {
      ok: true
      locator: Locator
      used: SchemaLocator
      fallbackIndex: number | undefined
      exact: boolean
    }
  | {
      ok: false
      reason: "not-grounded" | "target-not-found" | "target-ambiguous"
      detail: string
      exact: boolean
    }

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
      exact: false,
      reason: "not-grounded",
      detail: `target not grounded yet — intent "${target.intent}"`,
    }
  }
  const { fallbacks = [], nth, in: scope } = target
  // `nth` and the row (`in`) belong to the primary locator only: each fallback is its own locator.
  const candidates: { locator: SchemaLocator; nth: number | undefined; scope?: Scope }[] = [
    { locator: stripExtras(target), nth, ...(scope !== undefined && { scope }) },
    ...fallbacks.map((locator) => ({ locator, nth: undefined })),
  ]
  let exact: boolean
  const deadline = Date.now() + timeoutMs
  // Ambiguity can be transient (a dialog fading out while a new one fades in): keep polling and
  // only report it if it's still the state at the deadline.
  let ambiguous: string | undefined
  let retried = false
  polls: for (;;) {
    ambiguous = undefined
    // Exact names while a field holding a secret is on the page (§3 A8), decided at every poll (a
    // field that renders mid-step is seen at once), and counted through the one helper.
    const names = await exactNamesFor(
      page,
      candidates.map((c) => c.locator),
    )
    exact = names.exact
    for (const [i, candidate] of candidates.entries()) {
      // In its row: that one row first (none yet: not found; several: which one is never guessed).
      let within: Locator | undefined
      if (candidate.scope !== undefined) {
        const found = await rowOf(page, candidate.scope)
        if ("count" in found) {
          if ((found.count ?? 0) > 1) {
            ambiguous = `${found.count} elements are ${describeScope(candidate.scope)} — make \`has\` a text only that row holds`
            break
          }
          continue
        }
        within = found.row
      }
      const r = await countUnderRule(page, candidate.locator, names, { ...(within && { within }) })
      exact ||= r.exact
      // The helper's confirmation turned the rule on: every candidate again, at once, exactly
      // (once per poll: a field that keeps flapping waits for the next one).
      if (r.exact && !names.exact && !retried) {
        retried = true
        continue polls
      }
      const count = r.count ?? 0
      if (count === 0 || (candidate.nth !== undefined && count <= candidate.nth)) continue
      if (candidate.nth === undefined && count > 1) {
        // Stop here: falling through to a fallback could act on a different element.
        ambiguous =
          candidate.scope !== undefined
            ? `${describeLocator(candidate.locator)} matches ${count} visible elements in ${describeScope(candidate.scope)} — a more precise locator (a row takes no \`nth\`)`
            : `${describeLocator(candidate.locator)} matches ${count} visible elements — add \`nth\` or a more precise locator`
        break
      }
      const visible = visibleOnly(toPlaywright(page, candidate.locator, r.exact, within))
      const locator = candidate.nth === undefined ? visible : visible.nth(candidate.nth)
      return {
        ok: true,
        exact,
        locator,
        used: candidate.locator,
        fallbackIndex: i === 0 ? undefined : i - 1,
      }
    }
    retried = false
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (ambiguous !== undefined) {
    return { ok: false, reason: "target-ambiguous", detail: ambiguous, exact }
  }
  const tried = candidates
    .map(
      (c) =>
        describeLocator(c.locator) + (c.scope !== undefined ? ` in ${describeScope(c.scope)}` : ""),
    )
    .join(", then ")
  return {
    ok: false,
    reason: "target-not-found",
    detail: `target not found — tried ${tried}`,
    exact,
  }
}

/** The locator part of a grounded target, without the healing metadata. */
export function stripExtras(target: GroundedTarget): SchemaLocator {
  const {
    intent: _intent,
    fallbacks: _fallbacks,
    fingerprint: _fingerprint,
    nth: _nth,
    in: _in,
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
    .evaluate(pointProbe, [x, y, false, true] as [number, number, boolean, boolean], {
      timeout: timeoutMs,
    })
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
 * What's under a point (runs in the page, self-contained so it can be passed to `evaluate`). Goes
 * down through open shadow roots to the deepest element, then walks up the composed tree (slots,
 * shadow hosts) to tell whether the hit is `el` or inside it (`strict`), or also inside `el`'s
 * enclosing control (Playwright accepts a hit anywhere in the button a target sits in). With
 * `withLabel`, also returns everything the element under the point is called, for the risky check:
 * the control it belongs to (its text, shadow text and every naming attribute inside), or for a
 * non-control its own text and attributes without nested controls' text.
 */
/** Arguments of `pointProbe`: point, whether to read the label, strict hit test, marker token. */
export type ProbeArgs = [number, number, boolean, boolean, string?]

export function pointProbe(
  el: Element,
  [x, y, withLabel, strict, token]: ProbeArgs,
): { hits: boolean; label: string; sameAsMarked: boolean } {
  const CONTROLS =
    "button, a, input, [role=button], [role=link], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=tab], [role=option]"
  let hit = document.elementFromPoint(x, y)
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y)
    if (inner === null || inner === hit) break
    hit = inner
  }
  const up = (n: Node): Node | null =>
    (n instanceof Element ? n.assignedSlot : null) ??
    n.parentNode ??
    (n instanceof ShadowRoot ? n.host : null)
  const closest = (from: Element | null): Element | null => {
    for (let n: Node | null = from; n !== null; n = up(n))
      if (n instanceof Element && n.matches(CONTROLS)) return n
    return null
  }
  const within = (node: Node | null, ancestor: Element | null): boolean => {
    for (let n = node; n !== null; n = up(n)) if (n === ancestor) return true
    return false
  }
  const hits = hit !== null && (within(hit, el) || (!strict && within(hit, closest(el))))
  // Mark the element under the point (a JS property, invisible to the page) so a later probe can
  // tell whether the same node is still there.
  const marks = hit as unknown as { __kiframeProbe?: string } | null
  const sameAsMarked = token !== undefined && marks !== null && marks.__kiframeProbe === token
  if (token !== undefined && marks !== null) marks.__kiframeProbe ??= token
  if (!withLabel || hit === null) return { hits, label: "", sameAsMarked }
  const texts: (string | null | undefined)[] = []
  const attrs = (e: Element) => {
    const root = e.getRootNode() as Document | ShadowRoot
    for (const attr of ["alt", "aria-label", "title"]) texts.push(e.getAttribute(attr))
    for (const id of (e.getAttribute("aria-labelledby") ?? "").split(/\s+/)) {
      if (id !== "")
        texts.push(root.getElementById(id)?.textContent ?? document.getElementById(id)?.textContent)
    }
    if (
      e instanceof HTMLInputElement &&
      ["submit", "button", "reset", "image"].includes(e.type.toLowerCase())
    ) {
      texts.push(e.value)
    }
  }
  // Composed walk: light DOM children and open shadow roots, skipping nested controls if asked.
  const walk = (node: Node, skipControls: boolean) => {
    // A <slot> shows what's assigned to it (light-DOM content), not its own children.
    const own =
      node instanceof HTMLSlotElement ? node.assignedNodes({ flatten: true }) : [...node.childNodes]
    const children = [
      ...own,
      ...(node instanceof Element && node.shadowRoot ? [node.shadowRoot] : []),
    ]
    for (const child of children) {
      if (child.nodeType === Node.TEXT_NODE) texts.push("\uE000" + (child.textContent ?? ""))
      else if (child instanceof Element) {
        if (skipControls && child.matches(CONTROLS)) continue
        attrs(child)
        walk(child, skipControls)
      } else if (child instanceof ShadowRoot) walk(child, skipControls)
    }
  }
  // Fail closed on everything the press can activate: the target itself, and every control from
  // the hit up (a click bubbles: an inner "Open" inside an outer "Delete row" activates both).
  attrs(el)
  const control = closest(hit)
  if (control !== null) {
    for (let c: Element | null = control; c !== null; c = closest(up(c) as Element | null)) {
      texts.push(c instanceof HTMLElement ? c.innerText : null)
      attrs(c)
      walk(c, false)
    }
  } else {
    // Not a control (a card's background, a row's cell): the element itself, not the buttons in it.
    attrs(hit)
    walk(hit, true)
  }
  // Two readings, both checked (fail closed): pieces separated by spaces, and adjacent text nodes
  // glued (\uE000 marks them), so "<b>Del</b>ete" is found as "Delete" and "open"+"delete" as two words.
  const pieces = texts.filter((s): s is string => typeof s === "string")
  const spaced = pieces.join(" ").replace(/\uE000/g, "")
  const glued = pieces
    .join(" ")
    .replace(/ \uE000/g, "")
    .replace(/\uE000/g, "")
  const label = `${spaced} ${glued}`
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
  return { hits, label, sameAsMarked }
}

/**
 * A locator's visible matches under the exact-names rule of the moment (SECRETS-DESIGN §3 A8): the
 * rule checked, the locator counted, and a partial match confirmed by a second check (a field
 * holding a secret may render in between: then only an exact match counts). `count` is undefined
 * when a navigation replaced the page mid-count. The one way every check counts a locator.
 */
export async function countUnderRule(
  page: Page,
  locator: SchemaLocator,
  /** The rule already decided for this poll (several locators counted at once). */
  decided?: { exact: boolean; unsure: boolean },
  o: {
    /** Narrows the locator (the upload's `input[type=file]`). */
    refine?: (l: Locator) => Locator
    /** Count hidden matches too (a hidden file input). */
    hidden?: boolean
    /** Skip the confirmation (the caller confirms once for several counts). */
    confirm?: boolean
    /** The row it's looked for in (a target's `in`). */
    within?: Locator
  } = {},
): Promise<{ count: number | undefined; exact: boolean; unsure: boolean }> {
  const build = (exact: boolean) => {
    const base = (o.refine ?? ((l: Locator) => l))(toPlaywright(page, locator, exact, o.within))
    return o.hidden === true ? base : visibleOnly(base)
  }
  const countWith = (exact: boolean) =>
    build(exact)
      .count()
      .catch((error: unknown) => {
        if (isNavigationError(error)) return undefined
        throw error
      })
  const names = decided ?? (await exactNamesFor(page, [locator]))
  let { exact, unsure } = names
  let count = await countWith(exact)
  if (o.confirm !== false && count !== undefined && count > 0 && !exact && isPartialName(locator)) {
    const again = await exactNamesFor(page, [locator])
    if (again.exact) {
      ;({ exact, unsure } = again)
      count = await countWith(true)
    }
  }
  return { count, exact, unsure }
}

/** The page's document (its time origin: a new one per navigation or reload, none changed). */
export async function documentOf(page: Page): Promise<number | undefined> {
  return page.evaluate(() => performance.timeOrigin).catch(() => undefined)
}
