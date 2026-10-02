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
    if (page === undefined || page.isClosed()) return
    const last = await page
      .screenshot({ type: "jpeg", quality: 70, timeout: 2000 })
      .catch(() => undefined)
    if (last !== undefined) this.#send({ jpeg: last.toString("base64"), path: pathOf(page) })
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
          const now = Date.now()
          if (now - this.#lastSent < FRAME_MS || page !== this.#followed) return
          this.#lastSent = now
          this.#send({ jpeg: data.toString("base64"), path: pathOf(page) })
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
