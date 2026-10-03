// A recorded scene played as it exports: the compositor's own player on a canvas (captions,
// cursor, zoom, blurred secrets), with play/pause and a scrubber. A scene that can't play says why.
import { flatten, Player } from "@kiframe/compositor"
import { Pause, Play, WarningCircle } from "@phosphor-icons/react"
import { useEffect, useRef, useState } from "react"
import { api } from "../api.ts"

type Loaded =
  | { state: "loading" }
  | { state: "error"; why: string }
  | { state: "ready"; player: Player; title: string }

export function PreviewPlayer(props: {
  sceneId: string
  /** The scene's take and what it plays (a new take, or the scene edited, loads it again). */
  take: string | undefined
  version: string | undefined
  /** Shown (else hidden and paused, kept loaded). */
  active?: boolean
}) {
  const { sceneId, take, version, active = true } = props
  const canvas = useRef<HTMLCanvasElement>(null)
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" })
  const [, setTick] = useState(0)

  useEffect(() => {
    let gone = false
    let player: Player | undefined
    setLoaded({ state: "loading" })
    void (async () => {
      try {
        const preview = await api().invoke("preview:open", sceneId)
        if (gone) return
        if (!preview.ok) {
          setLoaded({ state: "error", why: preview.why })
          return
        }
        const target = canvas.current
        if (target === null) return
        player = await Player.load(target, {
          // Read where IPC put it (a buffer of its own): never copied.
          video: preview.video as Uint8Array<ArrayBuffer>,
          composition: preview.composition,
          scenario: preview.scenario,
          take: preview.take,
          // The scene's style as it exports (main resolved its layers and its output's size).
          style: flatten(preview.style, preview.format),
        })
        if (gone) {
          player.dispose()
          return
        }
        player.subscribe(() => setTick((t) => t + 1))
        setLoaded({ state: "ready", player, title: preview.title })
      } catch (error) {
        if (!gone) {
          setLoaded({
            state: "error",
            why: `It didn’t play: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      }
    })()
    return () => {
      gone = true
      player?.dispose()
    }
  }, [sceneId, take, version])

  const player = loaded.state === "ready" ? loaded.player : undefined
  useEffect(() => {
    if (!active) player?.pause()
  }, [active, player])
  return (
    <div className="player" hidden={!active}>
      <canvas
        ref={canvas}
        className="player-canvas"
        hidden={loaded.state !== "ready"}
        aria-label={loaded.state === "ready" ? `Preview of ${loaded.title}` : undefined}
      />
      {loaded.state === "loading" && <p className="player-note">Loading the take…</p>}
      {loaded.state === "error" && (
        <p className="player-note" role="status">
          <WarningCircle size={15} />
          {loaded.why}
        </p>
      )}
      {player !== undefined && (
        <div className="player-bar">
          <button
            type="button"
            className="icon-button"
            aria-label={player.playing ? "Pause" : "Play"}
            onClick={() => (player.playing ? player.pause() : player.play())}
          >
            {player.playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
          </button>
          <input
            type="range"
            className="player-scrub"
            aria-label="Position"
            min={0}
            max={Math.round(player.duration)}
            step={1}
            value={Math.round(player.time)}
            onChange={(e) => void player.seek(Number(e.target.value))}
          />
          <span className="player-time mono">
            {clock(player.time)} / {clock(player.duration)}
          </span>
        </div>
      )}
    </div>
  )
}

/** m:ss of a time in ms. */
export function clock(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}
