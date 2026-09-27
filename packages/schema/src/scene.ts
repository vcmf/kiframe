import * as z from "zod"
import { Ms, StepId } from "./common.ts"
import { guarded } from "./guards.ts"

// A scene's metadata, `scenes/<sceneId>/scene.json` (docs/OBJECT-MODEL.md §0.6): a base (the
// source) + overlays (composition.json) + a duration. A recording's scenario lives next to it in
// scenario.yaml; its overlays in composition.json. v0 kinds: `recording` and `card`.

/** Stable scene id (kebab-case, like step ids): sequences, outputs and takes refer to it. */
export const SceneId = StepId
export type SceneId = z.infer<typeof SceneId>

export const CardTemplate = z.enum(["title", "section", "text", "bullets", "cta", "outro"])
export type CardTemplate = z.infer<typeof CardTemplate>

export const CardContent = z.strictObject({
  heading: z.string().min(1).max(200),
  body: z.string().min(1).max(2000).optional(),
  bullets: z.array(z.string().min(1).max(200)).min(1).max(8).optional(),
  /** Show the org's logo (brand kit). */
  logo: z.boolean().optional(),
})
export type CardContent = z.infer<typeof CardContent>

export const SceneSource = z.discriminatedUnion("kind", [
  /** Filmed from `scenario.yaml` (the take is in the take store, never in the project). */
  z.strictObject({ kind: z.literal("recording") }),
  /** A brand template: title, section, text, bullets, call to action, outro. */
  z
    .strictObject({ kind: z.literal("card"), template: CardTemplate, content: CardContent })
    .refine((c) => (c.template === "bullets") === (c.content.bullets !== undefined), {
      message: "`bullets` goes with the bullets template, and that template needs it",
      path: ["content", "bullets"],
    }),
])
export type SceneSource = z.infer<typeof SceneSource>

export const Transition = z.strictObject({
  kind: z.enum(["cut", "fade", "slide", "zoom"]),
  ms: Ms.max(3000),
})
export type Transition = z.infer<typeof Transition>

export const SceneDuration = z.discriminatedUnion("mode", [
  /** Recording: the take after its clips; card: the reading time of its text (≥ 2 s). */
  z.strictObject({ mode: z.literal("auto") }),
  z.strictObject({ mode: z.literal("fixed"), ms: Ms.min(500).max(600_000) }),
])
export type SceneDuration = z.infer<typeof SceneDuration>

/** Unguarded: internal only, use the guarded export. */
const SceneBase = z
  .strictObject({
    version: z.literal(1),
    id: SceneId,
    /** On the scene card, and as the slide / guide heading. */
    title: z.string().min(1).max(200),
    /** The brief from the chat; used by the guide. */
    notes: z.string().min(1).max(10_000).optional(),
    source: SceneSource,
    duration: SceneDuration.default({ mode: "auto" }),
    /** How it joins the previous scene of the sequence. */
    transitionIn: Transition.optional(),
  })
  .refine((s) => s.source.kind !== "recording" || s.duration.mode === "auto", {
    message: "a recording lasts as long as its take (use clips to speed up or cut it)",
    path: ["duration"],
  })

/** A scene, with whole-document guards (forbidden keys; no secret references anywhere). */
export const Scene = guarded(SceneBase)
export type Scene = z.infer<typeof SceneBase>

/** Words per minute used for reading time (captions and cards), and the minimum on screen. */
const READING_WPM = 180
const MIN_CARD_MS = 2000

/** How long a card stays on screen in `auto` mode: the time to read it, at least 2 s. */
export function cardReadingMs(content: CardContent): number {
  const text = [content.heading, content.body ?? "", ...(content.bullets ?? [])].join(" ")
  const words = text.trim().split(/\s+/).filter(Boolean).length
  return Math.max(MIN_CARD_MS, Math.round((words / READING_WPM) * 60_000))
}
