// Draws the app icon from Kif's pixel map (src/shared/kif.ts) into resources/: icon.svg, icon.png
// (1024 px, macOS's margin around the tile) and, on macOS, icon.icns.
// Run after changing the map: `node apps/desktop/scripts/make-icon.ts`.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PNG } from "pngjs"
import { ICON_GRID, iconRuns } from "../src/shared/kif.ts"

const out = join(import.meta.dirname, "../resources")

/** The icon as SVG: one rect per run, crisp edges. */
export function iconSvg(): string {
  const rects = iconRuns().flatMap(({ color, runs }) =>
    runs.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${color}"/>`),
  )
  const n = ICON_GRID
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">\n${rects.join("\n")}\n</svg>\n`
}

/** The 1024 px PNG: 30 px cells, the 840 px tile centered (macOS's icon grid leaves a margin). */
export function iconPng(): Buffer {
  const size = 1024
  const cell = 30
  const margin = (size - ICON_GRID * cell) / 2
  const img = new PNG({ width: size, height: size })
  for (const { color, runs } of iconRuns()) {
    const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
    for (const r of runs)
      for (let y = r.y * cell; y < (r.y + 1) * cell; y++)
        for (let x = r.x * cell; x < (r.x + r.w) * cell; x++)
          img.data.set([...rgb, 255], ((margin + y) * size + margin + x) * 4)
  }
  return PNG.sync.write(img)
}

if (import.meta.main) {
  writeFileSync(join(out, "icon.svg"), iconSvg())
  const png = join(out, "icon.png")
  writeFileSync(png, iconPng())
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "kiframe-icon-"))
    const set = join(dir, "icon.iconset")
    execFileSync("mkdir", [set])
    for (const s of [16, 32, 128, 256, 512])
      for (const [px, name] of [
        [s, `icon_${s}x${s}.png`],
        [s * 2, `icon_${s}x${s}@2x.png`],
      ] as const)
        execFileSync("sips", ["-z", String(px), String(px), png, "--out", join(set, name)])
    execFileSync("iconutil", ["-c", "icns", set, "-o", join(out, "icon.icns")])
    rmSync(dir, { recursive: true })
  }
}
