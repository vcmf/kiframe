// Browser entry for exporting (bundled with esbuild): the Electron exporter and the browser tests
// load it in a page and call `window.kiframeExport`.
import { exportVideo, type ExportOptions } from "../src/index.ts"

export interface PageExportArgs extends Omit<ExportOptions, "video" | "onProgress"> {
  /** URL the page can fetch the take's frames.webm from. */
  videoUrl: string
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
  const video = await (await fetch(args.videoUrl)).blob()
  const result = await exportVideo({ ...args, video })
  const bytes = new Uint8Array(result.data)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return { ...result, data: btoa(binary) }
}
