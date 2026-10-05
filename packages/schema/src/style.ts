import * as z from "zod"
import { CAMERA_SCALE } from "./settings.ts"

// Output style (docs/OBJECT-MODEL.md §0.5, §5): what the compositor draws around and over the take.
// Resolved in layers: product defaults → org → project → output (APPROACHES §10c). Every layer but
// the first is a partial override; `applyStyle` merges them.

/** A CSS hex color, `#rrggbb`. */
export const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colors are #rrggbb")

/** A brand asset: content-addressed, `assets/<sha256>.<ext>` in the project folder. */
export const AssetRef = z
  .string()
  .regex(/^[0-9a-f]{64}\.(png|jpe?g|svg|webp)$/, "an asset is <sha256>.<png|jpg|jpeg|svg|webp>")
export type AssetRef = z.infer<typeof AssetRef>

/** Output shapes for videos: 16:9, 9:16 (social cut), 1:1. */
export const OutputPreset = z.enum(["landscape", "vertical", "square"])
export type OutputPreset = z.infer<typeof OutputPreset>

export const OUTPUT_PRESETS: Record<OutputPreset, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
}

/** An explicit output size (overrides the preset). Even sizes: H.264 needs them. */
export const Format = z.strictObject({
  width: z
    .number()
    .int()
    .min(240)
    .max(7680)
    .refine((n) => n % 2 === 0, "even sizes only"),
  height: z
    .number()
    .int()
    .min(240)
    .max(7680)
    .refine((n) => n % 2 === 0, "even sizes only"),
  fps: z
    .union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)])
    .optional(),
})
export type Format = z.infer<typeof Format>

const CursorStyle = z.strictObject({
  /** Cursor height in output pixels at scale 1. */
  size: z.number().int().min(8).max(96),
})
const CaptionStyle = z.strictObject({
  /** Font size in output pixels. */
  size: z.number().int().min(12).max(120),
  position: z.enum(["bottom", "top"]),
})

/** Kiframe's own background images (packages/compositor/backgrounds/backgrounds.json). */
export const BUILTIN_BACKGROUNDS = ["mountain-lake", "forest-lake", "autumn-road"] as const
export const BuiltinBackground = z.enum(BUILTIN_BACKGROUNDS)
export type BuiltinBackground = z.infer<typeof BuiltinBackground>

/**
 * What's behind the app (OBJECT-MODEL §0.14): one of Kiframe's images, or none (the app fills the
 * frame: no padding, no window look). Images only for now (decided by the user, 2026-10-05).
 */
export const Background = z.union([
  z.literal("none"),
  z.strictObject({ builtin: BuiltinBackground }),
])
export type Background = z.infer<typeof Background>

/** A complete style (the product defaults, or the result of resolution). */
export const Style = z.strictObject({
  background: Background,
  /**
   * Space around the window where the background shows, as a fraction of the output's shorter
   * side (≤ 0.3: content keeps ≥ 40%). None without a background (`framePadding`).
   */
  padding: z.number().min(0).max(0.3),
  /** Window corner radius, in output pixels. */
  radius: z.number().int().min(0).max(200),
  cursor: CursorStyle,
  captions: CaptionStyle,
  /** Hard zoom cap; beyond the source resolution the image gets soft (PHASE0-FINDINGS F2). */
  maxScale: z.number().min(CAMERA_SCALE.min).max(CAMERA_SCALE.max),
})
export type Style = z.infer<typeof Style>

/** The background's format before 2026-10-05: two colors (read as unset, nothing else is). */
const FormerGradient = z.tuple([Color, Color])

/** A partial style, one level deep: an override sets only what it names. */
export const StyleOverride = z.strictObject({
  // A gradient (the format before 2026-10-05, never set by the user: no UI wrote it) reads as
  // unset, the default then: a file of before still opens.
  background: z.preprocess(
    (v) => (FormerGradient.safeParse(v).success ? undefined : v),
    Style.shape.background.optional(),
  ),
  padding: Style.shape.padding.optional(),
  radius: Style.shape.radius.optional(),
  cursor: CursorStyle.partial().optional(),
  captions: CaptionStyle.partial().optional(),
  maxScale: Style.shape.maxScale.optional(),
})
export type StyleOverride = z.infer<typeof StyleOverride>

export const DEFAULT_STYLE: Style = {
  background: { builtin: "mountain-lake" },
  padding: 0.06,
  radius: 18,
  cursor: { size: 30 },
  captions: { size: 36, position: "bottom" },
  maxScale: 2.5,
}

/** Applies overrides in order (later wins), field by field; nested objects merge. */
export function applyStyle(base: Style, ...overrides: (StyleOverride | undefined)[]): Style {
  // Fresh objects all the way down: a caller editing its result never changes a lower layer.
  let style: Style = {
    ...base,
    background: copyBackground(base.background),
    cursor: { ...base.cursor },
    captions: { ...base.captions },
  }
  for (const o of overrides) {
    if (o === undefined) continue
    style = {
      background: o.background !== undefined ? copyBackground(o.background) : style.background,
      padding: o.padding ?? style.padding,
      radius: o.radius ?? style.radius,
      cursor: { size: o.cursor?.size ?? style.cursor.size },
      captions: {
        size: o.captions?.size ?? style.captions.size,
        position: o.captions?.position ?? style.captions.position,
      },
      maxScale: o.maxScale ?? style.maxScale,
    }
  }
  return style
}

function copyBackground(b: Background): Background {
  return b === "none" ? "none" : { ...b }
}

/** Brand kit (org level): used by `card` scenes and, later, the guide's look. */
export const Brand = z.strictObject({
  logo: AssetRef.optional(),
  primary: Color.optional(),
  /** A font family name available to the renderer (bundled or system). */
  font: z.string().min(1).max(100).optional(),
})
export type Brand = z.infer<typeof Brand>
