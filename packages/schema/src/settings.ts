import * as z from "zod"
import { Ms } from "./common.ts"

// Settings shared by the project config and per-scene overrides.
// Each setting has a "shape" without defaults (used for partial overrides, so an override never
// re-fills fields it didn't set) and a full schema with defaults (used at the project level).

export const ViewportShape = z.strictObject({
  width: z.number().int().min(320).max(7680),
  height: z.number().int().min(240).max(4320),
  /** Capture at DPR 2 so zooms stay sharp (APPROACHES §6). */
  deviceScaleFactor: z.number().min(1).max(3),
})
export const Viewport = ViewportShape.extend({
  deviceScaleFactor: ViewportShape.shape.deviceScaleFactor.default(2),
})
export type Viewport = z.infer<typeof Viewport>

export const PacingShape = z.strictObject({
  cursor: z.enum(["natural", "fast", "instant"]),
  typing: z.enum(["human", "fast", "instant"]),
  /** Wait after each action for the UI to settle, in ms. */
  settleMs: Ms,
})
export const Pacing = PacingShape.extend({
  cursor: PacingShape.shape.cursor.default("natural"),
  typing: PacingShape.shape.typing.default("human"),
  settleMs: PacingShape.shape.settleMs.default(400),
})
export type Pacing = z.infer<typeof Pacing>

/** Maximum playback speed of a step or a clip segment. */
export const MAX_SPEED = 16

/** Camera zoom bounds (1 = full frame). Also capped at render time by the source resolution. */
export const CAMERA_SCALE = { min: 1, max: 4 } as const

/** Names of presets, environments and rules: kebab/snake case, never prototype keys like `__proto__`. */
export const RuleName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "names must start with a-z or 0-9 and use a-z, 0-9, - or _")
