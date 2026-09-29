import { CAPTURE_LAG_MS, rectUnion, type TakeEvent, type ViewportRect } from "@kiframe/schema"

// Secret regions with their whole time spans (SECRETS-DESIGN §5, T1–T8): the recorder reports what
// the runtime read, when; this writes each region once, at the end, as one `sensitive` event whose
// boxes the compositor draws exactly (no timing rules of its own).

export { CAPTURE_LAG_MS }

/**
 * T3/T4: what is displayed can run up to this far from what the page reports (a compositor
 * scroll ahead of the DOM, a frame drawn just after a read from the state before it).
 */
export const FRAME_MARGIN_MS = 50

type Sensitive = Extract<TakeEvent, { kind: "sensitive" }>

/** A read of the page (T2): what it saw held at some moment in `[start, end]`. */
export interface Read {
  start: number
  end: number
  /** When the capture could first show the page read (T3); by default the last page switch. */
  floor?: number
}

/** A box, and when the page left it (`left`: its end waits for a frame that shows the change). */
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
  /** Its last read (on screen or not). */
  last: Read
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

  /** T3: the earliest a box first seen by a read could have been on screen. */
  #appear(t: number, read: Read): number {
    return Math.min(Math.max(t - FRAME_MARGIN_MS, read.floor ?? this.#switched), read.end)
  }

  /**
   * Region `id` read at `rect` (T2–T4). `since`: when its first box may have appeared (T3: the
   * last scan that didn't see it, a field's `type_start`); by default its previous read's start.
   * Moved since its previous read: the hull of both boxes covers the way between, and the old box
   * and the hull are left at this read's end. A read older than the region's last one only adds
   * coverage.
   */
  seen(
    id: string,
    why: Sensitive["why"],
    base: Open["base"],
    read: Read,
    rect: ViewportRect,
    since?: number,
  ): void {
    const region = this.#open.get(id)
    if (region === undefined) {
      const from = this.#appear(since ?? read.start, read)
      this.#open.set(id, { base, why, boxes: [], current: { from, rect }, last: read })
      return
    }
    if (read.start < region.last.start) {
      // Older information: what it saw may have been on screen then (never replaces the box).
      if (region.current === undefined || !same(region.current.rect, rect)) {
        const from = this.#appear(read.start, read)
        region.boxes.push({ from, until: read.end, rect, left: read.end })
      }
      return
    }
    const end = Math.max(read.end, region.last.end)
    const { current } = region
    if (current === undefined) {
      region.current = { from: this.#appear(since ?? region.last.start, read), rect }
    } else if (!same(current.rect, rect)) {
      const from = this.#appear(region.last.start, read)
      region.boxes.push({ from: current.from, until: end, rect: current.rect, left: end })
      // (A hull that is one of the two boxes, a full-frame fallback or a field that grew, adds
      // nothing: the new box starts as early.)
      const between = rectUnion(current.rect, rect)
      if (!same(between, current.rect) && !same(between, rect)) {
        region.boxes.push({ from, until: end, rect: between, left: end })
      }
      region.current = { from, rect }
    }
    region.last = { start: read.start, end }
  }

  /** Region `id` read gone: its box is left at the read's end (T4). */
  gone(id: string, read: Read): void {
    const region = this.#open.get(id)
    if (region === undefined || read.start < region.last.start) return
    const end = Math.max(read.end, region.last.end)
    const { current } = region
    if (current !== undefined) {
      region.boxes.push({ from: current.from, until: end, rect: current.rect, left: end })
      region.current = undefined
    }
    region.last = { start: read.start, end }
  }

  /**
   * Every region, each box closed by `end` (the end of the scene) at the latest. A box the page
   * left at `s` lasts until the first frame drawn at or after `s + FRAME_MARGIN_MS`, rounded up
   * to the millisecond (`frameAfter`; undefined: none came, it lasts to the end): the video holds
   * the last frame until a new one comes. By default a frame comes at once.
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
          const next = left === undefined ? until : frameAfter(left + FRAME_MARGIN_MS)
          const tail = next === undefined ? end : Math.ceil(Math.max(next, until))
          const f = Math.max(0, Math.min(from, end))
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
