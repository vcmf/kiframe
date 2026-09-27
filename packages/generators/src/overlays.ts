import type { CaptionSegment, CursorSegment, MaskSegment } from "@kiframe/schema"
import { anchorFor, eventId, type Timeline } from "./timeline.ts"

// Captions, cursor effects and masks (docs/OBJECT-MODEL.md §4.1).

/** One caption per step that has one, for the whole step (its reading time comes from a freeze). */
export function generateCaptions(tl: Timeline): CaptionSegment[] {
  return tl.steps.flatMap((s) =>
    s.step.caption === undefined
      ? []
      : [
          {
            id: `caption:${s.id}`,
            source: "auto" as const,
            at: { step: s.id, edge: "start" as const },
            until: { step: s.id, edge: "end" as const },
            text: s.step.caption,
          },
        ],
  )
}

/** Duration of a click ripple. */
export const RIPPLE_MS = 500
/** Time between the ripples of a double click. */
const DOUBLE_CLICK_GAP_MS = 120

/** A ripple on every on-camera click, and the cursor hidden on steps with `cursor: hide`. */
export function generateCursor(tl: Timeline): CursorSegment[] {
  const out: CursorSegment[] = []
  for (const s of tl.steps) {
    if (s.step.cursor === "hide") {
      out.push({
        id: `cursor:hidden:${s.id}`,
        source: "auto",
        kind: "hidden",
        at: { step: s.id, edge: "start" },
        until: { step: s.id, edge: "end" },
      })
    }
    // No ripple where the author hid the cursor.
    if (s.step.cursor === "hide") continue
    const clicks = tl.events.filter(
      (e) => e.kind === "click" && e.phase === "steps" && e.stepId === s.id,
    )
    clicks.forEach((click, n) => {
      const event = eventId(s.id, "click", n)
      // A double click shows two ripples, a little apart.
      const count = click.kind === "click" ? (click.count ?? 1) : 1
      for (let k = 0; k < count; k++) {
        const offset = k * DOUBLE_CLICK_GAP_MS
        out.push({
          id: k === 0 ? `cursor:ripple:${event}` : `cursor:ripple:${event}#${k}`,
          source: "auto",
          kind: "click-ripple",
          at: offset === 0 ? { event } : { event, offsetMs: offset },
          until: { event, offsetMs: offset + RIPPLE_MS },
        })
      }
    })
  }
  return out
}

/**
 * A blur for every sensitive region, from its first rect until it's gone (an empty rect) or the
 * end of the take. The renderer places it at the region's latest rect: it follows the element.
 */
export function generateMasks(tl: Timeline): MaskSegment[] {
  const out: MaskSegment[] = []
  const open = new Map<string, number>()
  const count = new Map<string, number>()
  const close = (id: string, until: MaskSegment["until"]) => {
    const at = open.get(id)
    if (at === undefined) return
    open.delete(id)
    const n = count.get(id) ?? 0
    count.set(id, n + 1)
    out.push({
      id: `mask:${id}:${n}`,
      source: "auto",
      kind: "blur",
      // Rounded outwards: a privacy mask never leaves a frame uncovered.
      at: anchorFor(at, tl, "down"),
      until,
      target: { sensitiveId: id },
    })
  }
  for (const e of tl.events) {
    if (e.kind !== "sensitive") continue
    const gone = e.rect.w === 0 || e.rect.h === 0
    if (gone) close(e.id, anchorFor(e.t, tl, "up"))
    else if (!open.has(e.id)) open.set(e.id, e.t)
  }
  for (const id of [...open.keys()]) close(id, { scene: "end" })
  return out
}
