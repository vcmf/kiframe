// Kif, the agent's mark: a pixel play button with two eyes (the video is the agent) and a sparkle.
// One pixel map for the app icon (scripts/make-icon.ts) and the chat's mark (kif-mark.tsx).

/** A run of pixels on one row: `w` cells from (x, y). */
export interface Run {
  x: number
  y: number
  w: number
}

/** The app icon's grid: 28 cells, the tile with stepped corners, the mark inside it. */
export const ICON_GRID = 28
export const COLORS = { tile: "#17171A", accent: "#D63D17", sparkle: "#F5F5F6" } as const

// The play button's row widths, top half: stepping 1-2-1-2 so its slope reads clean.
const PLAY_WIDTHS = [2, 3, 5, 6, 8, 9, 11, 12]

/** The play button, 12 × 16 cells, its top-left at (x, y). */
export function play(x: number, y: number): Run[] {
  return Array.from({ length: 16 }, (_, i) => ({
    x,
    y: y + i,
    w: PLAY_WIDTHS[i < 8 ? i : 15 - i] as number,
  }))
}

/** The eyes, cut out of the play button: two slits, 1 × 3 cells, three cells apart. */
export function eyes(x: number, y: number): Run[] {
  return [0, 1, 2].flatMap((i) => [
    { x: x + 3, y: y + 6 + i, w: 1 },
    { x: x + 6, y: y + 6 + i, w: 1 },
  ])
}

/**
 * The sparkle centered on (x, y): long arms and a diamond core (a plain plus reads as "add").
 * `small` is its twinkle frame: the core alone.
 */
export function sparkle(x: number, y: number, small = false): Run[] {
  const arm = small ? 1 : 3
  const rows: Run[] = []
  for (let d = -arm; d <= arm; d++) {
    if (d === 0) rows.push({ x: x - arm, y, w: 2 * arm + 1 })
    else if (Math.abs(d) === 1 && !small) rows.push({ x: x - 1, y: y + d, w: 3 })
    else rows.push({ x, y: y + d, w: 1 })
  }
  return rows
}

/** The tile: the icon's square with corners stepped on a 6-cell radius. */
export function tile(): Run[] {
  const n = ICON_GRID
  const r = 6
  return Array.from({ length: n }, (_, y) => {
    const cy = y < r ? r - y - 0.5 : y >= n - r ? y - (n - r) + 0.5 : 0
    // The first cell inside the rounded corner on this row.
    let x = 0
    while (x < r) {
      const cx = r - x - 0.5
      if (cy === 0 || cx * cx + cy * cy <= r * r + 0.5) break
      x++
    }
    return { x, y, w: n - 2 * x }
  })
}

/** The app icon as colored runs, painted in order (later runs over earlier ones). */
export function iconRuns(): { color: string; runs: Run[] }[] {
  return [
    { color: COLORS.tile, runs: tile() },
    { color: COLORS.accent, runs: play(9, 6) },
    { color: COLORS.tile, runs: eyes(9, 6) },
    { color: COLORS.sparkle, runs: sparkle(21, 6) },
  ]
}
