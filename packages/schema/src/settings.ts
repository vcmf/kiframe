import * as z from "zod"
import { Ms } from "./common.ts"

// Settings shared by the project config and per-scene overrides.

export const Viewport = z.strictObject({
  width: z.number().int().min(320).max(7680),
  height: z.number().int().min(240).max(4320),
  /** Capture at DPR 2 so zooms stay sharp (APPROACHES §6). */
  deviceScaleFactor: z.number().min(1).max(3).default(2),
})
export type Viewport = z.infer<typeof Viewport>

export const Pacing = z.strictObject({
  cursor: z.enum(["natural", "fast", "instant"]).default("natural"),
  typing: z.enum(["human", "fast", "instant"]).default("human"),
  /** Wait after each action for the UI to settle, in ms. */
  settleMs: Ms.default(400),
})
export type Pacing = z.infer<typeof Pacing>

/** Maximum playback speed of a step or a clip segment. */
export const MAX_SPEED = 16

/** Camera zoom bounds (1 = full frame). Also capped at render time by the source resolution. */
export const CAMERA_SCALE = { min: 1, max: 4 } as const
