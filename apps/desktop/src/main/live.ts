// The live app as the window shows it: the screencast of the studio's live page (and the page the
// runner switched to), view only, a few frames a second. Frames go to the window, never the model.
import type { Page } from "playwright"
import type { LiveFrame } from "../shared/ipc.ts"

/** How often the page followed is checked (a popup the runner switched to), and frames sent. */
const FOLLOW_MS = 400
const FRAME_MS = 125

export class LiveView {
  readonly #page: () => Page | undefined
  readonly #send: (frame: LiveFrame) => void
  #followed: Page | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #lastSent = 0
  #latest: { page: Page; data: Buffer } | undefined
  #pending: ReturnType<typeof setTimeout> | undefined
  #switching: Promise<void> = Promise.resolve()

  constructor(page: () => Page | undefined, send: (frame: LiveFrame) => void) {
    this.#page = page
    this.#send = send
  }

  /** Follows the live page until `stop`. */
  start(): void {
    if (this.#timer !== undefined) return
    this.#follow()
    this.#timer = setInterval(() => this.#follow(), FOLLOW_MS)
  }

  /**
   * Stops the screencast. The last frame stays shown: one of the page as it is now (the run's
   * last step may have changed it after the last frame sent, or between frames).
   */
  async stop(): Promise<void> {
    clearInterval(this.#timer)
    this.#timer = undefined
    await this.#switching
    const page = this.#page() ?? this.#followed
    await this.#switch(undefined)
    clearTimeout(this.#pending)
    this.#pending = undefined
    this.#latest = undefined
    if (page === undefined || page.isClosed()) return
    const last = await page
      .screenshot({ type: "jpeg", quality: 70, timeout: 2000 })
      .catch(() => undefined)
    if (last !== undefined) this.#send({ jpeg: last.toString("base64"), path: pathOf(page) })
  }

  #flush(): void {
    this.#pending = undefined
    const latest = this.#latest
    this.#latest = undefined
    if (latest === undefined || latest.page !== this.#followed) return
    this.#lastSent = Date.now()
    this.#send({ jpeg: latest.data.toString("base64"), path: pathOf(latest.page) })
  }

  #follow(): void {
    const page = this.#page()
    if (page === this.#followed) return
    // One switch at a time: a slow start never runs over the next one.
    this.#switching = this.#switching.then(() => this.#switch(page))
  }

  async #switch(page: Page | undefined): Promise<void> {
    if (page === this.#followed) return
    const old = this.#followed
    this.#followed = page
    await old?.screencast.stop().catch(() => undefined)
    if (page === undefined) return
    await page.screencast
      .start({
        quality: 70,
        onFrame: ({ data }) => {
          if (page !== this.#followed) return
          // At most every FRAME_MS, and never the last of a burst dropped: the latest one waits
          // for its turn (the page may then stay still, the screencast sends nothing more).
          this.#latest = { page, data }
          if (this.#pending !== undefined) return
          const wait = Math.max(0, this.#lastSent + FRAME_MS - Date.now())
          this.#pending = setTimeout(() => this.#flush(), wait)
        },
      })
      .catch(() => {
        // A page closing as it's followed: the next check follows the next one.
        if (this.#followed === page) this.#followed = undefined
      })
  }
}

function pathOf(page: Page): string {
  try {
    return new URL(page.url()).pathname
  } catch {
    return ""
  }
}
