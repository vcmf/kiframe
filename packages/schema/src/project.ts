import * as z from "zod"
import { Ms } from "./common.ts"
import { Action, CameraDirective, Locator, SetupItem } from "./scenario.ts"

// Project-level configuration shared by every scene (docs/OBJECT-MODEL.md §2, §2b).
// Phase 0: the target URL lives here. Org-level environments come with accounts (APPROACHES §10c).

export const Viewport = z.strictObject({
  width: z.number().int().min(320).max(7680),
  height: z.number().int().min(240).max(4320),
  /** Capture at DPR 2 so zooms stay sharp (APPROACHES §6). */
  deviceScaleFactor: z.number().min(1).max(3).default(2),
})
export type Viewport = z.infer<typeof Viewport>

export const TargetApp = z.strictObject({
  kind: z.literal("web"),
  url: z.url(),
  viewport: Viewport,
})
export type TargetApp = z.infer<typeof TargetApp>

export const Pacing = z.strictObject({
  cursor: z.enum(["natural", "fast", "instant"]).default("natural"),
  typing: z.enum(["human", "fast", "instant"]).default("human"),
  /** Wait after each action for the UI to settle, in ms. */
  settleMs: Ms.default(400),
})
export type Pacing = z.infer<typeof Pacing>

export const Preset = z.strictObject({
  /** Run once per recording batch, then reuse its browser session (login presets). */
  session: z.boolean().default(false),
  steps: z.array(SetupItem).min(1),
})
export type Preset = z.infer<typeof Preset>

/** Off-camera handling of unpredictable popups, checked before each step (§2b). */
export const InterruptRule = z.strictObject({
  id: z.string().min(1).optional(),
  when: z.union([Locator, z.strictObject({ text: z.string().min(1) })]),
  do: Action,
})
export type InterruptRule = z.infer<typeof InterruptRule>

export const ProjectConfig = z.strictObject({
  version: z.literal(1),
  environment: z.string().min(1).optional(),
  target: TargetApp,
  defaults: z
    .object({
      pacing: Pacing.prefault({}),
      camera: CameraDirective.default("auto"),
    })
    .prefault({}),
  presets: z.record(z.string().min(1), Preset).default({}),
  interrupts: z.array(InterruptRule).default([]),
  /** CSS selectors hidden from the frame (display: none). */
  hide: z.array(z.string().min(1)).default([]),
  redaction: z
    .object({
      selectors: z.array(z.string().min(1)).default([]),
      secrets: z.literal("auto").default("auto"),
    })
    .prefault({}),
})
export type ProjectConfig = z.infer<typeof ProjectConfig>
