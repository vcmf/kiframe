import type { CaptionSegment, CursorSegment } from "@kiframe/schema"
import { eventId, type Timeline } from "./timeline.ts"

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
      // No ripple where the author hid the cursor.
      out.push({
        id: `cursor:hidden:${s.id}`,
        source: "auto",
        kind: "hidden",
        at: { step: s.id, edge: "start" },
        until: { step: s.id, edge: "end" },
      })
      continue
    }
    const clicks = tl.events.filter(
      (e): e is Extract<typeof e, { kind: "click" }> =>
        e.kind === "click" && e.phase === "steps" && e.stepId === s.id,
    )
    clicks.forEach((click, n) => {
      const event = eventId(s.id, "click", n)
      // A double click shows two ripples, a little apart.
      const count = click.count ?? 1
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
