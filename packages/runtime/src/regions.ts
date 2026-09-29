import type { TakeEvent, ViewportRect } from "@kiframe/schema"

// Secret regions with their whole time spans (SECRETS-DESIGN §5): the recorder reports what it
// measured, when; this writes each region once, at the end, as one `sensitive` event whose boxes the
// compositor draws exactly (no timing rules of its own).

/**
 * Frames can show the page as it was up to this long before (the capture lags the DOM): a region
 * gone at `s` stays covered until `s` plus this (§5 R4; the R8 budget until the lag is measured).
 */
export const CAPTURE_LAG_MS = 500

type Sensitive = Extract<TakeEvent, { kind: "sensitive" }>
type Box = Sensitive["boxes"][number]

interface Open {
  base: Pick<Sensitive, "phase" | "stepId">
  why: Sensitive["why"]
  boxes: Box[]
  /** The box it's in now (its `until` still open), if it's on screen. */
  current: { from: number; rect: ViewportRect } | undefined
  /** When it was last measured. */
  measured: number
}

const same = (a: ViewportRect, b: ViewportRect) =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h

/** The smallest rect holding both. */
export function hull(a: ViewportRect, b: ViewportRect): ViewportRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  }
}

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
   * on the page being captured).
   * Moved since the last measurement `p`: the hull of both boxes covers `[p, at]` (it may have been
   * anywhere between).
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
    const { current } = region
    if (current === undefined) {
      region.current = {
        from: Math.min(Math.max(since ?? region.measured, this.#switched), at),
        rect,
      }
    } else if (!same(current.rect, rect)) {
      region.boxes.push({ from: current.from, until: at, rect: current.rect })
      region.boxes.push({ from: region.measured, until: at, rect: hull(current.rect, rect) })
      region.current = { from: at, rect }
    }
    region.measured = at
  }

  /** Region `id` measured gone at `at`: covered until the capture has caught up. */
  gone(id: string, at: number): void {
    const region = this.#open.get(id)
    if (region === undefined) return
    const { current } = region
    if (current !== undefined) {
      region.boxes.push({ from: current.from, until: at + CAPTURE_LAG_MS, rect: current.rect })
      region.current = undefined
    }
    region.measured = at
  }

  /** Every region, each box closed by `end` (the end of the scene) at the latest. */
  finish(end: number): Sensitive[] {
    const out: Sensitive[] = []
    for (const [id, region] of this.#open) {
      const boxes = [...region.boxes]
      if (region.current !== undefined) {
        boxes.push({ from: region.current.from, until: end, rect: region.current.rect })
      }
      const clamped = boxes
        .map((b) => ({ ...b, from: Math.min(b.from, end), until: Math.min(b.until, end) }))
        .sort((a, b) => a.from - b.from)
      if (clamped.length === 0) continue
      out.push({
        ...region.base,
        t: Math.min(...clamped.map((b) => b.from)),
        kind: "sensitive",
        id,
        why: region.why,
        until: Math.max(...clamped.map((b) => b.until)),
        boxes: clamped,
      })
    }
    this.#open.clear()
    return out
  }
}
