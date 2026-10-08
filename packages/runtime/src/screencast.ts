import type { Page } from "playwright"

// One screencast per page (Playwright allows no more), shared: the recorder films it and the host's
// live view shows it at once (a handover on a recording's page), each subscribed for its frames.
// The hub alone starts and stops it: no one stops it under another.

/** A frame as Playwright gives it (`timestamp`: epoch milliseconds). */
export interface CastFrame {
  data: Buffer
  timestamp: number
}

interface Cast {
  subscribers: Set<(frame: CastFrame) => void>
  /** The last frame sent (a page that stays still sends no other). */
  last?: CastFrame
  size: { width: number; height: number }
  quality: number
}

const casts = new WeakMap<Page, Cast>()
/** A page's starts, restarts and stops, in turn (never two at once, whichever cast asks). */
const turns = new WeakMap<Page, Promise<void>>()

function inTurn(page: Page, work: () => Promise<void>): Promise<void> {
  const run = (turns.get(page) ?? Promise.resolve()).then(work)
  turns.set(
    page,
    run.catch(() => undefined),
  )
  return run
}

/**
 * Frames of `page` to `onFrame` until the returned function is called. Shared: at the largest size
 * and best quality any subscriber asked (a larger one restarts it: the others get the larger
 * frames). Rejects if the page's screencast can't start (a closing page).
 */
export async function watchScreencast(
  page: Page,
  options: {
    size: { width: number; height: number }
    quality: number
    /** The page as it is now, at once (a still page sends no frame until it changes): a viewer's. */
    current?: boolean
  },
  onFrame: (frame: CastFrame) => void,
): Promise<() => Promise<void>> {
  let cast = casts.get(page)
  const fresh = cast === undefined
  if (cast === undefined) {
    cast = { subscribers: new Set(), size: options.size, quality: options.quality }
    casts.set(page, cast)
  }
  const own = cast
  const larger =
    !fresh &&
    (options.size.width * options.size.height > own.size.width * own.size.height ||
      options.quality > own.quality)
  if (larger) {
    own.size =
      options.size.width * options.size.height > own.size.width * own.size.height
        ? options.size
        : own.size
    own.quality = Math.max(own.quality, options.quality)
  }
  own.subscribers.add(onFrame)
  const start = () =>
    page.screencast.start({
      size: own.size,
      quality: own.quality,
      onFrame: (frame) => {
        own.last = frame
        for (const subscriber of own.subscribers) subscriber(frame)
      },
    })
  if (fresh || larger) {
    try {
      await inTurn(page, async () => {
        if (larger) await page.screencast.stop().catch(() => undefined)
        await start()
      })
    } catch (error) {
      // Its screencast is gone (a restart stops it first): never left for others to join.
      own.subscribers.delete(onFrame)
      if (casts.get(page) === own) casts.delete(page)
      throw error
    }
  }
  // Joined a screencast already running: its last frame, if this one wants the page as it is.
  if (!fresh && !larger && options.current === true && own.last !== undefined) {
    const last = own.last
    queueMicrotask(() => {
      if (own.subscribers.has(onFrame)) onFrame(last)
    })
  }
  let done = false
  return async () => {
    if (done) return
    done = true
    own.subscribers.delete(onFrame)
    if (own.subscribers.size > 0) return
    casts.delete(page)
    await inTurn(page, () => page.screencast.stop().catch(() => undefined))
  }
}
