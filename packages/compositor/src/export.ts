import type { TakeInput } from "@kiframe/generators"
import type { Composition, Scenario, Style as SchemaStyle } from "@kiframe/schema"
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  canEncodeVideo,
  Input,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
  type VideoCodec,
} from "mediabunny"
import { drawScene } from "./draw.ts"
import { prepare, sceneAt, type Style } from "./scene.ts"

// Export in the browser (docs/OBJECT-MODEL.md §5): frames.webm → decode (WebCodecs, via Mediabunny)
// → draw each output frame → encode (WebCodecs, hardware when available) → mux MP4/WebM.

export interface ExportOptions {
  /** The take's frames.webm. */
  video: Blob
  composition: Composition
  scenario: Scenario
  take: TakeInput
  /** The output layer (size, format, its overrides), on top of the scene's style. */
  style?: Partial<Style>
  /** Org + project style (`resolveStyle(org, project)`), below the scene's. Default: product defaults. */
  baseStyle?: SchemaStyle
  /** The style's background image, loaded (none: a gradient stands in). */
  background?: CanvasImageSource & { width: number; height: number }
  format: "mp4" | "webm"
  onProgress?: (done: number, total: number) => void
}

export interface ExportResult {
  data: ArrayBuffer
  codec: VideoCodec
  frames: number
  durationMs: number
  /** Output pixels per source pixel at the highest zoom (> 1: softer than the capture). */
  softness: number
}

/** Codecs to try, best first: H.264 isn't in every Chromium (Playwright's has none). */
const CODECS: Record<ExportOptions["format"], VideoCodec[]> = {
  mp4: ["avc", "hevc", "vp9", "av1"],
  webm: ["vp9", "av1", "vp8"],
}

export async function exportVideo(options: ExportOptions): Promise<ExportResult> {
  const prepared = prepare(
    options.composition,
    options.scenario,
    options.take,
    options.style,
    options.baseStyle,
  )
  const { style } = prepared
  const codec = await pickCodec(options.format, style)

  const input = new Input({ source: new BlobSource(options.video), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (track === null) throw new Error("the take has no video track")
  const firstTimestamp = await track.getFirstTimestamp()
  const sink = new CanvasSink(track, { poolSize: 2 })

  const canvas = new OffscreenCanvas(style.width, style.height)
  const ctx = canvas.getContext("2d")
  if (ctx === null) throw new Error("no 2D canvas context")
  const output = new Output({
    format:
      options.format === "mp4"
        ? new Mp4OutputFormat({ fastStart: "in-memory" })
        : new WebMOutputFormat(),
    target: new BufferTarget(),
  })
  const source = new CanvasSource(canvas, { codec, bitrate: 12_000_000, keyFrameInterval: 2 })
  output.addVideoTrack(source, { frameRate: style.fps })
  await output.start()

  const total = Math.max(1, Math.round((prepared.duration / 1000) * style.fps))
  const scenes = Array.from({ length: total }, (_, i) => sceneAt(prepared, (i * 1000) / style.fps))
  // Source timestamps only move forward (clips keep order): decoded in one sequential pass.
  const timestamps = scenes.map((s) => firstTimestamp + s.sourceT / 1000)
  let i = 0
  for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
    const scene = scenes[i]
    if (scene === undefined) break
    if (wrapped !== null) drawScene(ctx, wrapped.canvas, scene, style, options.background)
    await source.add(i / style.fps, 1 / style.fps)
    i++
    options.onProgress?.(i, total)
  }
  await output.finalize()
  const data = output.target.buffer
  if (data === null) throw new Error("the export produced no data")
  return {
    data,
    codec,
    frames: i,
    durationMs: (i * 1000) / style.fps,
    softness: prepared.softness,
  }
}

async function pickCodec(format: ExportOptions["format"], style: Style): Promise<VideoCodec> {
  for (const codec of CODECS[format]) {
    if (
      await canEncodeVideo(codec, { width: style.width, height: style.height, bitrate: 12_000_000 })
    ) {
      return codec
    }
  }
  throw new Error(`no ${format} video encoder available in this browser`)
}
