// Kif's mark above each agent turn: the app icon's play button with eyes, and its sparkle.
import { useId } from "react"
import { eyes, play, type Run, sparkle } from "../../../shared/kif.ts"

// The icon's mark, cropped: the play button's top-left at (0, 3), the sparkle centered on (12, 3).
const PLAY = play(0, 3)
const EYES = eyes(0, 3)
const SPARKLE = sparkle(12, 3)
const TWINKLE = sparkle(12, 3, true)

const rects = (runs: Run[]) =>
  runs.map((r) => <rect key={`${r.x},${r.y}`} x={r.x} y={r.y} width={r.w} height={1} />)

/**
 * One cell is one CSS pixel (crisp at any screen scale). `working`: Kif looks at its sparkle,
 * which twinkles, and blinks (the turn being written); still otherwise.
 */
export function KifMark({ working }: { working: boolean }) {
  const mask = useId()
  return (
    <svg
      className={working ? "kif-mark working" : "kif-mark"}
      width={16}
      height={19}
      viewBox="0 0 16 19"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <mask id={mask}>
        <rect width={16} height={19} fill="#fff" />
        <g className="kif-eyes" fill="#000">
          {/* Its own group: the blink squeezes both eyes whole while the glance moves them. */}
          <g className="kif-lids">{rects(EYES)}</g>
        </g>
      </mask>
      <g className="kif-play" mask={`url(#${mask})`}>
        {rects(PLAY)}
      </g>
      <g className="kif-sparkle">{rects(SPARKLE)}</g>
      <g className="kif-twinkle">{rects(TWINKLE)}</g>
    </svg>
  )
}
