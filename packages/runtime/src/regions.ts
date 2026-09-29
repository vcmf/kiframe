import { CAPTURE_LAG_MS, rectUnion, type TakeEvent, type ViewportRect } from "@kiframe/schema"

// Secret regions with their whole time spans (SECRETS-DESIGN §5): the recorder reports what it
// measured, when; this writes each region once, at the end, as one `sensitive` event whose boxes the
// compositor draws exactly (no timing rules of its own).

export { CAPTURE_LAG_MS }

type Sensitive = Extract<TakeEvent, { kind: "sensitive" }>

/** A box, and when the page left it (`left`: its end waits for the capture to catch up). */
interface Box {
  from: number
  until: number
  rect: ViewportRect
  left?: number
}

interface Open {
  base: Pick<Sensitive, "phase" | "stepId">
  why: Sensitive["why"]
  boxes: Box[]
  /** The box it's in now (its `until` still open), if it's on screen. */
  current: { from: number; rect: ViewportRect } | undefined
  /** When it was last measured (on screen or not). */
  measured: number
}

const same = (a: ViewportRect, b: ViewportRect) =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

export class Regions {
  readonly #open = new Map<string, Open>()
  /** When the capture last switched pages: no region is backdated before it. */
  #switched = 0

  /** The capture switched pages at `at`. */
  switched(at: number): void {
    this.#switched = Math.max(this.#switched, at)
  }

  /**
   * Region `id` measured at `rect` at time `at`. `since`: the earliest it may have been on screen
   * (the last measurement that didn't see it); by default its own last measurement, or `at`. Never
   * before the last page switch (the frames before it show another page: a region is only measured
   * on the page being captured). Moved since the last measurement `p`: the hull of both boxes
   * covers `[p, at]` (it may have been anywhere between), and the old box and the hull stay for the
   * capture lag.
   */
  seen(
    id: string,
    why: Sensitive["why"],
    base: Open["base"],
    at: number,
    rect: ViewportRect,
    since?: number,
  ): void {
    const region = this.#open.get(id)
    if (region === undefined) {
      const from = Math.min(Math.max(since ?? at, this.#switched), at)
      this.#open.set(id, { base, why, boxes: [], current: { from, rect }, measured: at })
      return
    }
    // Never before its last measurement (a wall clock stepping back can't invert a box).
    const now = Math.max(at, region.measured)
    const { current } = region
    if (current === undefined) {
      const from = Math.max(since ?? region.measured, this.#switched)
      region.current = { from: Math.min(from, now), rect }
    } else if (!same(current.rect, rect)) {
      region.boxes.push({ from: current.from, until: now, rect: current.rect, left: now })
      // (A hull that is the old box itself, a full-frame fallback, adds nothing.)
      const between = rectUnion(current.rect, rect)
      if (!same(between, current.rect)) {
        region.boxes.push({ from: region.measured, until: now, rect: between, left: now })
      }
      region.current = { from: now, rect }
    }
    region.measured = now
  }

  /** Region `id` measured gone at `at`: covered until the capture has caught up. */
  gone(id: string, at: number): void {
    const region = this.#open.get(id)
    if (region === undefined) return
    const now = Math.max(at, region.measured)
    const { current } = region
    if (current !== undefined) {
      region.boxes.push({ from: current.from, until: now, rect: current.rect, left: now })
      region.current = undefined
    }
    region.measured = now
  }

  /**
   * Every region, each box closed by `end` (the end of the scene) at the latest. A box the page
   * left at `s` lasts until the first frame at or after `s` plus the capture lag
   * (`frameAfter`; undefined: none came, it lasts to the end): the video holds the last frame
   * until a new one comes. By default a frame comes at once.
   */
  finish(end: number, frameAfter: (t: number) => number | undefined = (t) => t): Sensitive[] {
    const out: Sensitive[] = []
    for (const [id, region] of this.#open) {
      const boxes: Box[] = [...region.boxes]
      if (region.current !== undefined) {
        boxes.push({ from: region.current.from, until: end, rect: region.current.rect })
      }
      const closed = boxes
        .map(({ from, until, rect, left }) => {
          // The first frame at or after `left` plus the lag replaces what may be stale.
          const tail = left === undefined ? until : (frameAfter(left + CAPTURE_LAG_MS) ?? end)
          const f = Math.min(from, end)
          return { from: f, until: Math.max(f, Math.min(tail, end)), rect }
        })
        .sort((a, b) => a.from - b.from)
      if (closed.length === 0) continue
      out.push({
        ...region.base,
        t: Math.min(...closed.map((b) => b.from)),
        kind: "sensitive",
        id,
        why: region.why,
        until: Math.max(...closed.map((b) => b.until)),
        boxes: closed,
      })
    }
    this.#open.clear()
    return out
  }
}
