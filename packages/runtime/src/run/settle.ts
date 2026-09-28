import type { Ctx } from "./context.ts"

// Waiting for the page to settle after an action (network and DOM quiet).

/** Upper bound of each settle wait: pages with constant activity (animations, polling) never block. */
export const SETTLE_MAX_MS = 3000

/**
 * After an action, wait for the app to settle (docs/OBJECT-MODEL.md §2b): no request in flight and
 * no DOM mutation for a short quiet period, then the project's extra `settleMs`. Each wait is
 * bounded and never fails the step.
 */
export async function settle(ctx: Ctx, onCamera: boolean): Promise<void> {
  // A page that closed (a popup's "Authorize" closes it after a request) has nothing to settle.
  if (ctx.page.isClosed()) return
  try {
    // Network and DOM are independent: wait for both at once, so the worst case is one cap.
    await Promise.all([ctx.network.waitForIdle(SETTLE_MAX_MS, 200), domQuiet(ctx)])
    if (onCamera && ctx.settleMs > 0) await ctx.page.waitForTimeout(ctx.settleMs)
  } catch (error) {
    if (ctx.page.isClosed()) return
    throw error
  }
}

export async function domQuiet(ctx: Ctx): Promise<void> {
  await ctx.page
    .evaluate(
      ({ quiet, max }) =>
        new Promise<void>((resolve) => {
          let timer = setTimeout(done, quiet)
          const bump = () => {
            clearTimeout(timer)
            timer = setTimeout(done, quiet)
          }
          const options = { subtree: true, childList: true, attributes: true, characterData: true }
          const observer = new MutationObserver(bump)
          // MutationObserver doesn't see into shadow roots: observe every open one as well
          // (web-component apps render inside them).
          const observed = new Set<Node>()
          const observe = (root: Node) => {
            if (observed.has(root)) return
            observed.add(root)
            observer.observe(root, options)
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
            for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
              const shadow = (n as Element).shadowRoot
              if (shadow !== null) observe(shadow)
            }
          }
          observe(document)
          const cap = setTimeout(done, max)
          function done() {
            observer.disconnect()
            clearTimeout(timer)
            clearTimeout(cap)
            resolve()
          }
        }),
      { quiet: 150, max: SETTLE_MAX_MS },
    )
    .catch(() => undefined) // the page navigated meanwhile: nothing to observe
}
