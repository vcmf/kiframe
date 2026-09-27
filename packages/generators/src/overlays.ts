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
    const clicks = tl.events.filter(
      (e) => e.kind === "click" && e.phase === "steps" && e.stepId === s.id,
    )
    clicks.forEach((_, n) => {
      const event = eventId(s.id, "click", n)
      out.push({
        id: `cursor:ripple:${event}`,
        source: "auto",
        kind: "click-ripple",
        at: { event },
        until: { event, offsetMs: RIPPLE_MS },
      })
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
  const close = (id: string, until: MaskSegment["until"]) => {
    const at = open.get(id)
    if (at === undefined) return
    open.delete(id)
    out.push({
      id: `mask:${id}:${out.filter((m) => "sensitiveId" in m.target && m.target.sensitiveId === id).length}`,
      source: "auto",
      kind: "blur",
      at: anchorFor(at, tl),
      until,
      target: { sensitiveId: id },
    })
  }
  for (const e of tl.events) {
    if (e.kind !== "sensitive") continue
    const gone = e.rect.w === 0 || e.rect.h === 0
    if (gone) close(e.id, anchorFor(e.t, tl))
    else if (!open.has(e.id)) open.set(e.id, e.t)
  }
  for (const id of [...open.keys()]) close(id, { scene: "end" })
  return out
}
