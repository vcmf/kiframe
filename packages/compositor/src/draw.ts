import { type Scene, stageTransform, type Style } from "./scene.ts"

// Draws a Scene with Canvas 2D (docs/OBJECT-MODEL.md §5): background → window → take frame through
// the camera → blurs → cursor → ripples → captions. No state: the same scene draws the same pixels.

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

type Frame = CanvasImageSource & { width: number; height: number }

/** Behind the window until the background's image is drawn: the former default gradient. */
const PLACEHOLDER = ["#1e1b4b", "#0f172a"] as const

export function drawScene(ctx: Ctx, frame: Frame, scene: Scene, style: Style): void {
  // Laid out from the take's frame size (the camera's box); the pixels from the decoded frame.
  const src = scene.frame
  // The camera over the whole picture (OBJECT-MODEL §0.14): the background with the app's window
  // on it, magnified by `scale` around the app point at the center.
  const t = stageTransform(style, src, scene.view)
  const { box, scale } = t
  const win = t.out(box.x, box.y)
  const ww = box.w * scale
  const wh = box.h * scale
  const radius = style.radius * scale

  // Background: none, black around the app (it fills the frame, bars only for another aspect);
  // an image, a gradient standing in until the image is drawn, moving with the picture.
  // The whole frame always painted (a canvas keeps the last frame's pixels where nothing is drawn),
  // the background and shadow skipped when the window covers it all (zoomed in: neither shows).
  // Covered with its rounded corners too (a corner's arc on screen would leave a notch unpainted).
  const inset = radius * (1 - Math.SQRT1_2)
  const covered =
    win.x + inset <= 0 &&
    win.y + inset <= 0 &&
    win.x + ww - inset >= style.width &&
    win.y + wh - inset >= style.height
  if (style.background === "none" || covered) {
    ctx.fillStyle = "#000"
    ctx.fillRect(0, 0, style.width, style.height)
  } else {
    const a = t.out(0, 0)
    const b = t.out(style.width, style.height)
    const bg = ctx.createLinearGradient(a.x, a.y, b.x, b.y)
    bg.addColorStop(0, PLACEHOLDER[0])
    bg.addColorStop(1, PLACEHOLDER[1])
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, style.width, style.height)
    // The window's shadow, as large as the window is (canvas shadows ignore any transform).
    ctx.save()
    ctx.shadowColor = "rgba(0, 0, 0, 0.45)"
    ctx.shadowBlur = 48 * scale
    ctx.shadowOffsetY = 16 * scale
    ctx.fillStyle = "#000"
    roundRect(ctx, win.x, win.y, ww, wh, radius)
    ctx.fill()
    ctx.restore()
  }

  // A point of the app on the output.
  const toOut = t.fromApp

  ctx.save()
  roundRect(ctx, win.x, win.y, ww, wh, radius)
  ctx.clip()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(frame, 0, 0, frame.width, frame.height, win.x, win.y, ww, wh)

  // Blurs: the same pixels, blurred, inside each rect (a strong blur: text must be unreadable).
  for (const r of scene.blurs) {
    const a = toOut(r.x, r.y)
    const b = toOut(r.x + r.w, r.y + r.h)
    ctx.save()
    ctx.beginPath()
    ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y)
    ctx.clip()
    ctx.filter = `blur(${Math.max(8, (b.y - a.y) / 3)}px)`
    ctx.drawImage(frame, 0, 0, frame.width, frame.height, win.x, win.y, ww, wh)
    ctx.filter = "none"
    // Blur alone can leave a long secret's shape guessable: a light veil on top.
    ctx.fillStyle = "rgba(128, 128, 128, 0.35)"
    ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y)
    ctx.restore()
  }

  // Ripples under the cursor.
  for (const r of scene.ripples) {
    const c = toOut(r.x, r.y)
    const radius = 10 + 34 * easeOut(r.progress)
    ctx.beginPath()
    ctx.arc(c.x, c.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(99, 102, 241, ${0.35 * (1 - r.progress)})`
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = `rgba(99, 102, 241, ${0.9 * (1 - r.progress)})`
    ctx.stroke()
  }

  if (scene.cursor !== undefined) {
    const c = toOut(scene.cursor.x, scene.cursor.y)
    // Slightly larger when zoomed in, not proportionally (it would get huge).
    const size = style.cursorSize * (1 + 0.25 * (scale - 1)) * (scene.cursor.pressed ? 0.9 : 1)
    drawArrow(ctx, c.x, c.y, size)
  }
  ctx.restore()

  // Captions shown together stack (bottom ones upwards, top ones downwards), never overlap.
  const offset = { top: 0, bottom: 0 }
  for (const caption of scene.captions) {
    const side = caption.position === "top" ? "top" : "bottom"
    offset[side] += drawCaption(ctx, caption.text, side, offset[side], style)
  }
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

const easeOut = (u: number) => 1 - (1 - u) ** 3

/** A classic arrow cursor with its tip at (x, y). */
function drawArrow(ctx: Ctx, x: number, y: number, size: number) {
  const k = size / 24
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(k, k)
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(0, 19)
  ctx.lineTo(4.5, 14.8)
  ctx.lineTo(7.6, 22)
  ctx.lineTo(11, 20.6)
  ctx.lineTo(7.9, 13.5)
  ctx.lineTo(14, 13.5)
  ctx.closePath()
  ctx.shadowColor = "rgba(0, 0, 0, 0.35)"
  ctx.shadowBlur = 4
  ctx.shadowOffsetY = 1
  ctx.fillStyle = "#111"
  ctx.fill()
  ctx.shadowColor = "transparent"
  ctx.lineWidth = 1.6
  ctx.strokeStyle = "#fff"
  ctx.stroke()
  ctx.restore()
}

/**
 * One caption on a dark pill, wrapped to at most 70% of the width, `shift` px further from the edge
 * (stacking). Returns the space it takes.
 */
function drawCaption(
  ctx: Ctx,
  text: string,
  side: "top" | "bottom",
  shift: number,
  style: Style,
): number {
  const size = style.captionSize
  ctx.save()
  ctx.font = `600 ${size}px -apple-system, "Segoe UI", system-ui, sans-serif`
  const maxW = style.width * 0.7
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/)) {
    const next = line === "" ? word : `${line} ${word}`
    if (ctx.measureText(next).width > maxW && line !== "") {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line !== "") lines.push(line)
  const lineH = size * 1.3
  const padX = size * 0.8
  const padY = size * 0.5
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 2 * padX
  const h = lines.length * lineH + 2 * padY
  const x = (style.width - w) / 2
  const margin = style.height * 0.06
  const y = side === "top" ? margin + shift : style.height - margin - h - shift
  ctx.fillStyle = "rgba(15, 23, 42, 0.86)"
  roundRect(ctx, x, y, w, h, Math.min(h / 2, size))
  ctx.fill()
  ctx.fillStyle = "#fff"
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  lines.forEach((l, i) => ctx.fillText(l, style.width / 2, y + padY + lineH * (i + 0.5)))
  ctx.restore()
  return h + size * 0.4
}
