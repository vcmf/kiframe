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
  const candidates = [stripExtras(target), ...fallbacks]
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const [i, candidate] of candidates.entries()) {
      const visible = visibleOnly(toPlaywright(page, candidate))
      const count = await visible.count()
      if (count === 0 || (nth !== undefined && count <= nth)) continue
      if (nth === undefined && count > 1) {
        return {
          ok: false,
          reason: "target-ambiguous",
          detail: `${describeLocator(candidate)} matches ${count} visible elements — add \`nth\` or a more precise locator`,
        }
      }
      const locator = nth === undefined ? visible : visible.nth(nth)
      return { ok: true, locator, used: candidate, fallbackIndex: i === 0 ? undefined : i - 1 }
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const tried = candidates.map(describeLocator).join(", then ")
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
  // Pages without a fixed viewport (CDP-connected, Electron) have no viewportSize(): ask the page.
  const viewport =
    page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return false
  return locator
    .evaluate(
      (el, [px, py]) => {
        const hit = document.elementFromPoint(px ?? 0, py ?? 0)
        return hit !== null && (hit === el || el.contains(hit))
      },
      [x, y],
      { timeout: timeoutMs },
    )
    .catch(() => false)
}
