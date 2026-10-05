// Browser entry for exporting (bundled with esbuild): the Electron exporter and the browser tests
// load it in a page and call `window.kiframeExport`.
import { exportVideo, type ExportOptions } from "../src/index.ts"

export interface PageExportArgs extends Omit<ExportOptions, "video" | "onProgress" | "background"> {
  /** URL the page can fetch the take's frames.webm from. */
  videoUrl: string
  /** URL of the style's background image (none: a gradient stands in). */
  backgroundUrl?: string
}

declare global {
  interface Window {
    kiframeExport: (args: PageExportArgs) => Promise<{
      /** The video file, base64. */
      data: string
      codec: string
      frames: number
      durationMs: number
      softness: number
    }>
  }
}

window.kiframeExport = async (args) => {
  const [video, background] = await Promise.all([
    loadVideo(args.videoUrl),
    args.backgroundUrl === undefined ? undefined : loadImage(args.backgroundUrl),
  ])
  const { backgroundUrl: _url, ...rest } = args
  const result = await exportVideo({
    ...rest,
    video,
    ...(background !== undefined && { background }),
  })
  const bytes = new Uint8Array(result.data)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return { ...result, data: btoa(binary) }
}

/** A background image, decoded (a failed load is an error: never a video with the wrong look). */
async function loadImage(url: string): Promise<ImageBitmap> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`couldn't load the background (${response.status})`)
  return createImageBitmap(await response.blob())
}

async function loadVideo(url: string): Promise<Blob> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`couldn't load the take video (${response.status})`)
  return response.blob()
}
