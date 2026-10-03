// A test page for the preview player (bundled by player.test.ts): one canvas, the player on it,
// and small hooks the test drives it with.
import { Player, type PlayerSource } from "../src/index.ts"

declare global {
  interface Window {
    playerTest: {
      load: (args: Omit<PlayerSource, "video"> & { videoUrl: string }) => Promise<number>
      seek: (t: number) => Promise<string>
      play: () => void
      pause: () => void
      state: () => { time: number; playing: boolean; pixels: string }
    }
  }
}

let player: Player | undefined
const canvas = document.createElement("canvas")
document.body.append(canvas)

/** A cheap fingerprint of what the canvas shows (a sparse sample of its pixels). */
function pixels(): string {
  const ctx = canvas.getContext("2d")
  if (ctx === null) return ""
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let sum = 0
  for (let i = 0; i < data.length; i += 4 * 997) sum = (sum * 31 + (data[i] ?? 0)) >>> 0
  return String(sum)
}

window.playerTest = {
  load: async ({ videoUrl, ...rest }) => {
    const video = await (await fetch(videoUrl)).blob()
    player = await Player.load(canvas, { ...rest, video })
    return player.duration
  },
  seek: async (t) => {
    await player?.seek(t)
    return pixels()
  },
  play: () => player?.play(),
  pause: () => player?.pause(),
  state: () => ({ time: player?.time ?? -1, playing: player?.playing ?? false, pixels: pixels() }),
}
