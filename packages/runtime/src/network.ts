import type { Page, Request } from "playwright"

/**
 * Tracks in-flight requests from the moment it's attached, so "network idle" means "no request
 * in flight for a quiet period NOW", not Playwright's `networkidle` load state (which is reached
 * once after a navigation and then returns immediately, even while an SPA is fetching).
 */
/** Requests still pending after this long are treated as long-lived (SSE, long polling, beacons). */
const LONG_LIVED_MS = 3000

export class NetworkTracker {
  /** In-flight requests and when they started. EventSource / WebSocket streams are never tracked. */
  private readonly inflight = new Map<Request, number>()
  private lastChange = Date.now()
  private readonly onStart = (r: Request) => {
    if (r.resourceType() === "eventsource" || r.resourceType() === "websocket") return
    this.change(() => this.inflight.set(r, Date.now()))
  }
  private readonly onEnd = (r: Request) => this.change(() => this.inflight.delete(r))

  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    page.on("request", this.onStart)
    page.on("requestfinished", this.onEnd)
    page.on("requestfailed", this.onEnd)
  }

  private change(fn: () => void) {
    fn()
    this.lastChange = Date.now()
  }

  /**
   * Resolves once no (short-lived) request has been in flight for `quietMs`, counting the quiet
   * period from this call at the earliest: a request the previous step just started may not have
   * been reported yet, and would otherwise be missed. False if `timeoutMs` passes first.
   */
  async waitForIdle(timeoutMs: number, quietMs = 500): Promise<boolean> {
    const start = Date.now()
    const deadline = start + timeoutMs
    for (;;) {
      const now = Date.now()
      const pending = [...this.inflight.values()].filter((since) => now - since < LONG_LIVED_MS)
      const quietSince = Math.max(this.lastChange, start)
      if (pending.length === 0 && now - quietSince >= quietMs) return true
      if (now >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  dispose() {
    this.page.off("request", this.onStart)
    this.page.off("requestfinished", this.onEnd)
    this.page.off("requestfailed", this.onEnd)
  }
}
