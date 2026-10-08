import type { Browser, BrowserContext } from "playwright"
import { untilStopped } from "./look.ts"

// An image file for the model (OBJECT-MODEL §0.12): never the file's bytes, always its pixels
// decoded and encoded again (no metadata: EXIF, GPS; a file that isn't an image fails). Its size is
// read from its header in Node first: a format the header doesn't say, or one too large, never
// reaches a decoder. The decoding happens in the browser's sandboxed renderer, never this process.

/** The formats read (their header parsed here): what the providers take, a GIF as one frame. */
export type ImageFormat = "png" | "jpeg" | "gif" | "webp"

/** What an image's header says. */
export interface ImageHeader {
  format: ImageFormat
  width: number
  height: number
  /** Several frames (an animated GIF, PNG or WebP): only the first is shown. */
  animated: boolean
}

/** Pixels decoded at most (about 100 MB in the renderer): a small file can decode huge. */
export const MAX_IMAGE_PIXELS = 25_000_000
/** The long side sent to the model: providers cap an image's size (base64 adds a third). */
export const MAX_IMAGE_SIDE = 2000
/** An image sent at most this large (a PNG over it: a JPEG, less and less fine; else refused). */
const MAX_SENT_BYTES = 3_000_000
const DECODE_MS = 10_000

/** An image that can't be shown: said to the agent as is. */
export class ImageRefusal extends Error {}

const MIME: Record<ImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

/** An image's format, size and frames from its header; undefined when it isn't one of them. */
export function imageHeader(bytes: Uint8Array): ImageHeader | undefined {
  try {
    return png(bytes) ?? gif(bytes) ?? jpeg(bytes) ?? webp(bytes)
  } catch {
    // A header cut short (reads past the end).
    return undefined
  }
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)
const ascii = (b: Uint8Array, at: number, n: number) =>
  String.fromCharCode(...b.subarray(at, at + n))
const valid = (h: ImageHeader) => (h.width > 0 && h.height > 0 ? h : undefined)

function png(b: Uint8Array): ImageHeader | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24 || sig.some((v, i) => b[i] !== v) || ascii(b, 12, 4) !== "IHDR") return
  const v = view(b)
  // An APNG says so in an acTL chunk before its first IDAT.
  let animated = false
  for (let at = 8; at + 8 <= b.length;) {
    const type = ascii(b, at + 4, 4)
    if (type === "acTL") animated = true
    if (type === "IDAT" || type === "IEND") break
    at += 12 + v.getUint32(at)
  }
  return valid({ format: "png", width: v.getUint32(16), height: v.getUint32(20), animated })
}

function gif(b: Uint8Array): ImageHeader | undefined {
  const sig = ascii(b, 0, 6)
  if (b.length < 13 || (sig !== "GIF87a" && sig !== "GIF89a")) return
  const v = view(b)
  let width = v.getUint16(6, true)
  let height = v.getUint16(8, true)
  // Frames counted up to two (the blocks walked; the global colour table skipped).
  let at = 13 + ((b[10] ?? 0) & 0x80 ? 3 * 2 ** (((b[10] ?? 0) & 7) + 1) : 0)
  let frames = 0
  const subBlocks = () => {
    while (at < b.length && b[at] !== 0) at += (b[at] ?? 0) + 1
    at++
  }
  while (at < b.length && frames < 2) {
    const block = b[at]
    if (block === 0x21) {
      at += 2
      subBlocks()
    } else if (block === 0x2c) {
      frames++
      // The decoder grows the picture to hold its first frame (where it sits, its size): counted.
      if (frames === 1) {
        width = Math.max(width, v.getUint16(at + 1, true) + v.getUint16(at + 5, true))
        height = Math.max(height, v.getUint16(at + 3, true) + v.getUint16(at + 7, true))
      }
      const flags = b[at + 9] ?? 0
      at += 10 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0) + 1
      subBlocks()
    } else break
  }
  return valid({ format: "gif", width, height, animated: frames > 1 })
}

function jpeg(b: Uint8Array): ImageHeader | undefined {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return
  const v = view(b)
  for (let at = 2; at + 4 <= b.length;) {
    if (b[at] !== 0xff) return
    const marker = b[at + 1] ?? 0
    // Fill bytes, and markers without a length.
    if (marker === 0xff) {
      at++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    // A start of frame (not DHT 0xc4, JPG 0xc8, DAC 0xcc): its size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return valid({
        format: "jpeg",
        height: v.getUint16(at + 5),
        width: v.getUint16(at + 7),
        animated: false,
      })
    }
    if (marker === 0xda || marker === 0xd9) return
    at += 2 + v.getUint16(at + 2)
  }
  return undefined
}

function webp(b: Uint8Array): ImageHeader | undefined {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return
  const v = view(b)
  const chunk = ascii(b, 12, 4)
  if (chunk === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return
    return valid({
      format: "webp",
      width: v.getUint16(26, true) & 0x3fff,
      height: v.getUint16(28, true) & 0x3fff,
      animated: false,
    })
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return
    const bits = v.getUint32(21, true)
    return valid({
      format: "webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
      animated: false,
    })
  }
  if (chunk === "VP8X") {
    const u24 = (at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)
    return valid({
      format: "webp",
      width: u24(24) + 1,
      height: u24(27) + 1,
      animated: ((b[20] ?? 0) & 0x02) !== 0,
    })
  }
  return undefined
}

/** An image ready for the model: a data URL (PNG, or JPEG for a large photo) and its sizes. */
export interface FittedImage {
  url: string
  header: ImageHeader
  /** The size sent (at most {@link MAX_IMAGE_SIDE} on its long side, turned as its EXIF says). */
  width: number
  height: number
}

/**
 * An image file's pixels for the model: its header checked here (a format it says, at most
 * {@link MAX_IMAGE_PIXELS}), decoded in a throwaway browser context (its first frame, turned as its
 * EXIF says), at most {@link MAX_IMAGE_SIDE} on its long side, encoded again. Never parsed as HTML:
 * the bytes go into `createImageBitmap` on a blank page.
 */
export async function fitImage(
  browser: Browser,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<FittedImage> {
  const header = imageHeader(bytes)
  if (header === undefined) {
    throw new ImageRefusal("it can't be decoded as an image (PNG, JPEG, GIF, WebP)")
  }
  if (header.width * header.height > MAX_IMAGE_PIXELS) {
    throw new ImageRefusal(
      `it's too large to show (${header.width}×${header.height} px; at most ${MAX_IMAGE_PIXELS / 1_000_000} million pixels)`,
    )
  }
  signal?.throwIfAborted()
  // The whole of it bounded and stopped with the run: a hung browser too (its context closed
  // whenever it comes).
  const held: { context?: BrowserContext } = {}
  let given = false
  const work = (async () => {
    const made = await browser.newContext()
    if (given) {
      await made.close().catch(() => undefined)
      throw new ImageRefusal("it took too long to decode")
    }
    held.context = made
    const page = await made.newPage()
    return page.evaluate(decode, {
      data: Buffer.from(bytes).toString("base64"),
      mime: MIME[header.format],
      side: MAX_IMAGE_SIDE,
      max: MAX_SENT_BYTES,
    })
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ImageRefusal("it took too long to decode")), DECODE_MS)
  })
  try {
    const fitted = await untilStopped(Promise.race([work, timeout]), signal)
    if (fitted === undefined) {
      throw new ImageRefusal("it can't be decoded as an image (PNG, JPEG, GIF, WebP)")
    }
    if (fitted === "too-large") {
      throw new ImageRefusal("it's too detailed to send (over 3 MB, even as a JPEG)")
    }
    return { ...fitted, header }
  } finally {
    given = true
    clearTimeout(timer)
    work.catch(() => undefined)
    await held.context?.close().catch(() => undefined)
  }
}

/** In the page: the image decoded, made smaller, encoded again (a data URL). */
async function decode({
  data,
  mime,
  side,
  max,
}: {
  data: string
  mime: string
  side: number
  max: number
}): Promise<{ url: string; width: number; height: number } | "too-large" | undefined> {
  const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
  let bitmap: ImageBitmap
  try {
    // Turned as its EXIF says (always, in Chromium); an animation's first frame.
    bitmap = await createImageBitmap(new Blob([raw], { type: mime }))
  } catch {
    return undefined
  }
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const draw = (flatten: boolean) => {
    const canvas = new OffscreenCanvas(width, height)
    const g = canvas.getContext("2d")
    if (g === null) throw new Error("no 2d canvas")
    // A JPEG has no alpha: transparent parts on white (never black).
    if (flatten) {
      g.fillStyle = "#fff"
      g.fillRect(0, 0, width, height)
    }
    g.imageSmoothingQuality = "high"
    g.drawImage(bitmap, 0, 0, width, height)
    return canvas
  }
  let blob = await draw(false).convertToBlob({ type: "image/png" })
  // A photo: a JPEG, less fine until it fits.
  for (const quality of [0.85, 0.7, 0.5]) {
    if (blob.size <= max) break
    blob = await draw(true).convertToBlob({ type: "image/jpeg", quality })
  }
  bitmap.close()
  if (blob.size > max) return "too-large"
  const out = new Uint8Array(await blob.arrayBuffer())
  let bin = ""
  for (let i = 0; i < out.length; i += 0x8000) {
    bin += String.fromCharCode(...out.subarray(i, i + 0x8000))
  }
  return { url: `data:${blob.type};base64,${btoa(bin)}`, width, height }
}
