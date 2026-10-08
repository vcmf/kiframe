import { readFileSync } from "node:fs"
import { join } from "node:path"
import { chromium, type Browser } from "playwright"
import { PNG } from "pngjs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { fitImage, imageHeader, ImageRefusal, MAX_IMAGE_SIDE } from "../src/image.ts"

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(import.meta.dirname, "fixtures/images", name)))

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser.close()
})

/** The colour at a point of an image the model gets (decoded in the browser, as the model would). */
async function pixel(url: string, x: number, y: number): Promise<number[]> {
  const page = await browser.newPage()
  try {
    return await page.evaluate(
      async ({ url, x, y }) => {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob())
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const g = canvas.getContext("2d")!
        g.drawImage(bitmap, 0, 0)
        return [...g.getImageData(x, y, 1, 1).data]
      },
      { url, x, y },
    )
  } finally {
    await page.close()
  }
}

const bytesOf = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64")

describe("an image's header", () => {
  it("says each format's size, and whether it has several frames", () => {
    expect(imageHeader(fixture("plain.png"))).toEqual({
      format: "png",
      width: 40,
      height: 20,
      animated: false,
    })
    expect(imageHeader(fixture("one-frame.gif"))).toMatchObject({ format: "gif", animated: false })
    expect(imageHeader(fixture("two-frames.gif"))).toMatchObject({
      format: "gif",
      width: 40,
      height: 20,
      animated: true,
    })
    expect(imageHeader(fixture("turned.jpg"))).toMatchObject({
      format: "jpeg",
      width: 40,
      height: 20,
    })
    for (const name of ["lossy.webp", "lossless.webp"]) {
      expect(imageHeader(fixture(name)), name).toEqual({
        format: "webp",
        width: 40,
        height: 20,
        animated: false,
      })
    }
    expect(imageHeader(fixture("two-frames.webp"))).toMatchObject({
      format: "webp",
      width: 40,
      height: 20,
      animated: true,
    })
  })

  it("counts a GIF's first frame where it sits (the decoder grows the picture to hold it)", () => {
    // A 1×1 screen whose first frame is 60000×60000 at (10, 20).
    const gif = Buffer.from(fixture("one-frame.gif"))
    const descriptor = gif.indexOf(0x2c, 13)
    gif.writeUInt16LE(10, descriptor + 1)
    gif.writeUInt16LE(20, descriptor + 3)
    gif.writeUInt16LE(60_000, descriptor + 5)
    gif.writeUInt16LE(60_000, descriptor + 7)
    gif.writeUInt16LE(1, 6)
    gif.writeUInt16LE(1, 8)
    expect(imageHeader(gif)).toMatchObject({ width: 60_010, height: 60_020 })
  })

  it("is none for what isn't one of the formats, or is cut short", () => {
    const text = (s: string) => new TextEncoder().encode(s)
    expect(imageHeader(text("<html><body>not an image</body></html>"))).toBeUndefined()
    // A BMP (the browser would sniff and decode it: never handed to it).
    expect(imageHeader(text("BM6\u0000\u0000\u0000\u0000\u0000"))).toBeUndefined()
    expect(imageHeader(fixture("plain.png").subarray(0, 20))).toBeUndefined()
    expect(imageHeader(new Uint8Array())).toBeUndefined()
  })
})

describe("fitImage", { timeout: 30_000 }, () => {
  it("sends the pixels, never the file: a PNG made again, its size kept", async () => {
    const fitted = await fitImage(browser, fixture("plain.png"))
    expect(fitted.url).toMatch(/^data:image\/png;base64,/)
    expect([fitted.width, fitted.height]).toEqual([40, 20])
    expect(await pixel(fitted.url, 5, 5)).toEqual([255, 0, 0, 255])
  })

  it("drops a JPEG's metadata and turns it as its EXIF says", async () => {
    const file = fixture("turned.jpg")
    expect(Buffer.from(file).includes("KIFRAME-EXIF-MARKER")).toBe(true)
    const fitted = await fitImage(browser, file)
    expect(bytesOf(fitted.url).includes("KIFRAME-EXIF-MARKER")).toBe(false)
    expect(bytesOf(fitted.url).includes("Exif")).toBe(false)
    // Stored 40×20, shown turned a quarter: 20×40.
    expect([fitted.width, fitted.height]).toEqual([20, 40])
  })

  it("shows an animated GIF's and WebP's first frame", async () => {
    for (const name of ["two-frames.gif", "two-frames.webp"]) {
      const fitted = await fitImage(browser, fixture(name))
      expect(fitted.header.animated, name).toBe(true)
      const [r, , b] = await pixel(fitted.url, 5, 5)
      expect([r, b], name).toEqual([255, 0])
    }
  })

  it("makes a large image at most 2,000 px on its long side", async () => {
    const big = new PNG({ width: 3000, height: 1500 })
    big.data.fill(200)
    const fitted = await fitImage(browser, PNG.sync.write(big))
    expect([fitted.width, fitted.height]).toEqual([MAX_IMAGE_SIDE, 1000])
    expect(fitted.header).toMatchObject({ width: 3000, height: 1500 })
  })

  it("sends a large photo as a JPEG, its transparent parts white", async () => {
    // Noise doesn't compress: over 3 MB as a PNG. Its top-left corner transparent.
    const noisy = new PNG({ width: 1600, height: 1600 })
    for (let i = 0; i < noisy.data.length; i += 4) {
      const p = i / 4
      const corner = p % 1600 < 100 && p < 1600 * 100
      noisy.data[i] = Math.floor(Math.random() * 256)
      noisy.data[i + 1] = Math.floor(Math.random() * 256)
      noisy.data[i + 2] = Math.floor(Math.random() * 256)
      noisy.data[i + 3] = corner ? 0 : 255
    }
    const fitted = await fitImage(browser, PNG.sync.write(noisy))
    expect(fitted.url).toMatch(/^data:image\/jpeg;base64,/)
    const [r, g, b] = await pixel(fitted.url, 50, 50)
    expect(Math.min(r!, g!, b!)).toBeGreaterThan(240)
  })

  it("refuses what isn't an image, or decodes too large, before any browser sees it", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>")
    await expect(fitImage(browser, html)).rejects.toThrow(ImageRefusal)
    await expect(fitImage(browser, html)).rejects.toThrow(/can't be decoded as an image/)
    // A PNG header saying 30000×30000 (a few bytes that would decode to 3.6 GB).
    const bomb = Buffer.from(fixture("plain.png"))
    bomb.writeUInt32BE(30_000, 16)
    bomb.writeUInt32BE(30_000, 20)
    let contexts = 0
    const counting = { newContext: () => (contexts++, browser.newContext()) } as unknown as Browser
    await expect(fitImage(counting, bomb)).rejects.toThrow(/too large to show \(30000×30000 px/)
    await expect(fitImage(counting, html)).rejects.toThrow(ImageRefusal)
    expect(contexts).toBe(0)
  })

  it("refuses a file whose header is right but whose pixels aren't", async () => {
    const broken = Buffer.from(fixture("plain.png"))
    broken.fill(0x41, 33)
    await expect(fitImage(browser, broken)).rejects.toThrow(/can't be decoded as an image/)
  })

  it("is bounded and stopped while the browser makes its context (a hung browser)", async () => {
    let closed = 0
    let made: (c: unknown) => void = () => undefined
    const hung = {
      newContext: () =>
        new Promise((resolve) => {
          made = resolve
        }),
    } as unknown as Browser
    const stop = new AbortController()
    const reading = fitImage(hung, fixture("plain.png"), stop.signal)
    setTimeout(() => stop.abort(new Error("stopped")), 50)
    await expect(reading).rejects.toThrow(/stopped/)
    // A context that comes after all is closed at once.
    made({ close: () => (closed++, Promise.resolve()) })
    await new Promise((r) => setTimeout(r, 20))
    expect(closed).toBe(1)
  })

  it("stops at once when the run is stopped, its context closed", async () => {
    const stop = new AbortController()
    stop.abort(new Error("stopped"))
    await expect(fitImage(browser, fixture("plain.png"), stop.signal)).rejects.toThrow(/stopped/)
    expect(browser.contexts()).toHaveLength(0)
  })
})
