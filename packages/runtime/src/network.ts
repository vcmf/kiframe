import type { Page, Request } from "playwright"

/**
 * Tracks in-flight requests from the moment it's attached, so "network idle" means "no request
 * in flight for a quiet period NOW", not Playwright's `networkidle` load state (which is reached
 * once after a navigation and then returns immediately, even while an SPA is fetching).
 */
export class NetworkTracker {
  private readonly inflight = new Set<Request>()
  private lastChange = Date.now()
  private readonly onStart = (r: Request) => this.change(() => this.inflight.add(r))
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

  /** Resolves once no request has been in flight for `quietMs`; false if `timeoutMs` passes first. */
  async waitForIdle(timeoutMs: number, quietMs = 500): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const now = Date.now()
      if (this.inflight.size === 0 && now - this.lastChange >= quietMs) return true
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
