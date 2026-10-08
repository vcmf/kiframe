// The live app as the window shows it: the screencast of the studio's live page (and the page the
// runner switched to), view only, a few frames a second. Frames go to the window, never the model.
import { watchScreencast } from "@kiframe/runtime"
import type { Page } from "playwright"
import type { LiveFrame } from "../shared/ipc.ts"

/** How often the page followed is checked (a popup the runner switched to), and frames sent. */
const FOLLOW_MS = 400
const FRAME_MS = 125
/** JPEG quality of the live frames (text on the page stays legible). */
const QUALITY = 80

/** Frames' page numbers, over every live view (a new one never reuses an old one's numbers). */
let gens = 0

export class LiveView {
  readonly #page: () => Page | undefined
  readonly #send: (frame: LiveFrame) => void
  #followed: Page | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #lastSent = 0
  readonly #refused = new WeakSet<Page>()
  #latest: { page: Page; data: Buffer } | undefined
  #pending: ReturnType<typeof setTimeout> | undefined
  #switching: Promise<void> = Promise.resolve()
  #unwatch: (() => Promise<void>) | undefined
  #gen = 0

  constructor(page: () => Page | undefined, send: (frame: LiveFrame) => void) {
    this.#page = page
    this.#send = send
  }

  /** The page the frames show now (a handover's input goes there). */
  get followed(): Page | undefined {
    return this.#followed
  }

  /** Which page the frames show now (a new one per page followed): input on an older one drops. */
  get gen(): number {
    return this.#gen
  }

  /** Follows the page it should now, at once, and waits until it does (its screencast moved). */
  async sync(): Promise<void> {
    if (this.#timer !== undefined) this.#follow()
    await this.#switching
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
      .screenshot({ type: "jpeg", quality: QUALITY, timeout: 2000 })
      .catch(() => undefined)
    if (last !== undefined) {
      this.#send({ jpeg: last.toString("base64"), path: pathOf(page), gen: this.#gen })
    }
  }

  #flush(): void {
    this.#pending = undefined
    const latest = this.#latest
    this.#latest = undefined
    if (latest === undefined || latest.page !== this.#followed) return
    this.#lastSent = Date.now()
    this.#send({ jpeg: latest.data.toString("base64"), path: pathOf(latest.page), gen: this.#gen })
  }

  #follow(): void {
    const found = this.#page()
    const page = found !== undefined && this.#refused.has(found) ? undefined : found
    if (page === this.#followed) return
    // One switch at a time: a slow start never runs over the next one.
    this.#switching = this.#switching.then(() => this.#switch(page))
  }

  async #switch(page: Page | undefined): Promise<void> {
    if (page === this.#followed) return
    this.#followed = page
    this.#gen = ++gens
    // Through the shared screencast: a recording films the same page during a handover.
    await this.#unwatch?.().catch(() => undefined)
    this.#unwatch = undefined
    if (page === undefined) return
    // At the page's own size, capped (sharp on the stage, without full-size frames over IPC
    // several times a second): unsized, Playwright scales every frame down to 800×500.
    const size = frameSize(page.viewportSize())
    await watchScreencast(page, { size, quality: QUALITY, current: true }, ({ data }) => {
      if (page !== this.#followed) return
      // At most every FRAME_MS, and never the last of a burst dropped: the latest one waits for
      // its turn (the page may then stay still, the screencast sends nothing more).
      this.#latest = { page, data }
      if (this.#pending !== undefined) return
      const wait = Math.max(0, this.#lastSent + FRAME_MS - Date.now())
      this.#pending = setTimeout(() => this.#flush(), wait)
    })
      .then((unwatch) => {
        // Left meanwhile: never kept.
        if (this.#followed === page) this.#unwatch = unwatch
        else void unwatch()
      })
      .catch(() => {
        // A page closing as it's followed, or one the screencast refuses: never tried again (the
        // next check follows the next page).
        this.#refused.add(page)
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

/** The longest side a live frame is sent at (the stage is narrower than most viewports). */
export const LIVE_MAX_SIDE = 1600

/**
 * A live frame's size: the page's viewport scaled to fit LIVE_MAX_SIDE (never up); a page with no
 * viewport (the window's own size) is sent at 1280×800.
 */
export function frameSize(viewport: { width: number; height: number } | null): {
  width: number
  height: number
} {
  const { width, height } = viewport ?? { width: 1280, height: 800 }
  const k = Math.min(1, LIVE_MAX_SIDE / Math.max(width, height))
  return { width: Math.round(width * k), height: Math.round(height * k) }
}
