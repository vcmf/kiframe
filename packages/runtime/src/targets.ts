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

/**
 * Resolves a target to exactly one visible element: the primary locator first, then each fallback
 * in order. The time budget is shared: each candidate gets an equal slice. A locator matching
 * several elements is an error unless `nth` picks one (never guess which element was meant).
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
  const primary: SchemaLocator = stripExtras(target)
  const candidates = [primary, ...fallbacks]
  const slice = Math.max(250, Math.floor(timeoutMs / candidates.length))
  const tried: string[] = []
  for (const [i, candidate] of candidates.entries()) {
    const all = toPlaywright(page, candidate)
    const locator = nth === undefined ? all : all.nth(nth)
    try {
      await locator.first().waitFor({ state: "visible", timeout: slice })
    } catch {
      tried.push(describeLocator(candidate))
      continue
    }
    if (nth === undefined) {
      const count = await all.count()
      if (count > 1) {
        return {
          ok: false,
          reason: "target-ambiguous",
          detail: `${describeLocator(candidate)} matches ${count} elements — add \`nth\` or a more precise locator`,
        }
      }
    }
    return { ok: true, locator, used: candidate, fallbackIndex: i === 0 ? undefined : i - 1 }
  }
  return {
    ok: false,
    reason: "target-not-found",
    detail: `target not found — tried ${tried.join(", then ")}`,
  }
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
export async function isOnScreen(page: Page, locator: Locator): Promise<boolean> {
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()
  if (box === null || viewport === null) return false
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return false
  return locator.evaluate(
    (el, [px, py]) => {
      const hit = document.elementFromPoint(px ?? 0, py ?? 0)
      return hit !== null && (hit === el || el.contains(hit))
    },
    [x, y],
  )
}
