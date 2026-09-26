import * as z from "zod"
import {
  claimIds,
  CssSelector,
  isRelativeUrl,
  Ms,
  RectTuple,
  secretRefName,
  StepId,
  withoutCredentials,
} from "./common.ts"
import { guarded } from "./guards.ts"
import { CAMERA_SCALE, MAX_SPEED, PacingShape, RuleName, ViewportShape } from "./settings.ts"

// ─── Locators and targets (docs/OBJECT-MODEL.md §2, APPROACHES §7.1) ─────────
// Black box: locators use roles, labels and text. `css` is a last resort.

const RoleLocator = z.strictObject({
  by: z.literal("role"),
  role: z.string().min(1),
  name: z.string().optional(),
  exact: z.boolean().optional(),
})
const LabelLocator = z.strictObject({
  by: z.literal("label"),
  name: z.string().min(1),
  exact: z.boolean().optional(),
})
const TextLocator = z.strictObject({
  by: z.literal("text"),
  text: z.string().min(1),
  exact: z.boolean().optional(),
})
const PlaceholderLocator = z.strictObject({ by: z.literal("placeholder"), text: z.string().min(1) })
const CssLocator = z.strictObject({ by: z.literal("css"), selector: CssSelector })

export const Locator = z.discriminatedUnion("by", [
  RoleLocator,
  LabelLocator,
  TextLocator,
  PlaceholderLocator,
  CssLocator,
])
export type Locator = z.infer<typeof Locator>

/** Fields every target can carry on top of its locator. */
const targetExtras = {
  /** Natural-language intent from the chat. Used to heal the locator when it breaks. */
  intent: z.string().min(1).optional(),
  /** Alternative locators tried in order if the primary one fails. */
  fallbacks: z.array(Locator).optional(),
  /** Path to a screenshot crop of the element, used as visual reference for self-healing. */
  fingerprint: z.string().optional(),
  /** Pick the n-th match (0-based) when the locator matches several elements. */
  nth: z.number().int().nonnegative().optional(),
}

/** A grounded target: a locator plus healing metadata. */
export const GroundedTarget = z.discriminatedUnion("by", [
  RoleLocator.extend(targetExtras),
  LabelLocator.extend(targetExtras),
  TextLocator.extend(targetExtras),
  PlaceholderLocator.extend(targetExtras),
  CssLocator.extend(targetExtras),
])
export type GroundedTarget = z.infer<typeof GroundedTarget>

/** A target the agent hasn't grounded yet: only the intent is known (scene status `draft`). */
export const UngroundedTarget = z.strictObject({ intent: z.string().min(1) })
export type UngroundedTarget = z.infer<typeof UngroundedTarget>

export const Target = z.union([GroundedTarget, UngroundedTarget])
export type Target = z.infer<typeof Target>

export function isGrounded(target: Target): target is GroundedTarget {
  return "by" in target
}

// ─── Conditions (waitFor / expect / ensure) ───────────────────────────────────

/** Exactly one condition form. */
export const Condition = z.union([
  z.strictObject({ visible: Locator }),
  z.strictObject({ hidden: Locator }),
  z.strictObject({ text: z.string().min(1) }),
  z.strictObject({ url: withoutCredentials(z.string().min(1)) }),
  z.strictObject({ networkIdle: z.literal(true) }),
])
export type Condition = z.infer<typeof Condition>

// ─── Presentation directives (§2b) ────────────────────────────────────────────

const frameTarget = z.union([z.literal("target"), Locator, z.strictObject({ rect: RectTuple })])
const scale = z.number().min(CAMERA_SCALE.min).max(CAMERA_SCALE.max).optional()

/**
 * Camera default for a project or a scene. No `until` (it only makes sense on a step), and no
 * `target` (many steps have none: framing the target is a per-step choice, `auto` covers the rest).
 */
export const CameraDefault = z.union([
  z.enum(["auto", "wide"]),
  z.strictObject({ follow: z.literal("cursor") }),
  z.strictObject({ frame: z.union([Locator, z.strictObject({ rect: RectTuple })]), scale }),
])
export type CameraDefault = z.infer<typeof CameraDefault>

/** Camera directive on a step. `until` keeps the framing until a later step. */
export const CameraDirective = z.union([
  z.enum(["auto", "wide", "target"]),
  z.strictObject({ follow: z.literal("cursor"), until: StepId.optional() }),
  z.strictObject({ frame: frameTarget, scale, until: StepId.optional() }),
])
export type CameraDirective = z.infer<typeof CameraDirective>

export const Emphasis = z.union([
  z.enum(["none", "highlight", "spotlight"]),
  z.strictObject({
    kind: z.enum(["highlight", "spotlight"]),
    on: z.union([z.literal("target"), Locator, z.strictObject({ rect: RectTuple })]),
  }),
])
export type Emphasis = z.infer<typeof Emphasis>

/** Presentation fields shared by every recorded step. They have no effect on the app. */
const presentation = {
  caption: z.string().min(1).optional(),
  instruction: z.string().min(1).optional(),
  camera: CameraDirective.optional(),
  emphasis: Emphasis.optional(),
  /** Presentation beat after the step, in ms. Never sped up. */
  hold: Ms.optional(),
  cursor: z.enum(["show", "hide"]).optional(),
  speed: z.number().positive().max(MAX_SPEED).optional(),
  keystrokes: z.enum(["show", "hide"]).optional(),
  /** Deletes, sends, pays or invites: needs confirmation unless pre-approved on a sandbox environment. */
  risky: z.boolean().optional(),
}

// ─── Actions (Phase 0 subset; full set in M1-1) ───────────────────────────────

const Goto = z.strictObject({
  action: z.literal("goto"),
  /** Relative to the environment's URL: `goto` never leaves the target app. */
  url: withoutCredentials(
    z.string().min(1).refine(isRelativeUrl, {
      message: "goto URL must be relative to the environment (e.g. `/projects`)",
    }),
  ),
})
const Click = z.strictObject({
  action: z.literal("click"),
  target: Target,
  button: z.enum(["left", "right"]).optional(),
  count: z.union([z.literal(1), z.literal(2)]).optional(),
  modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift", "Mod"])).optional(),
})
const Type = z.strictObject({
  action: z.literal("type"),
  target: Target,
  /** Text to type, or exactly a secret reference `{{secrets.<name>}}` (checked by the guards). */
  value: z.string(),
  clear: z.boolean().optional(),
  submit: z.boolean().optional(),
  /** Off camera: fill instantly instead of human typing. */
  instant: z.boolean().optional(),
})
const Press = z.strictObject({ action: z.literal("press"), keys: z.string().min(1) })
const Scroll = z.strictObject({
  action: z.literal("scroll"),
  to: Target.optional(),
  by: z.strictObject({ y: z.number() }).optional(),
  until: Target.optional(),
  within: Target.optional(),
})
const WaitFor = z.strictObject({
  action: z.literal("waitFor"),
  until: Condition,
  timeout: Ms.optional(),
})
const Pause = z.strictObject({ action: z.literal("pause"), ms: Ms })
const Expect = z.strictObject({
  action: z.literal("expect"),
  that: Condition,
  timeout: Ms.optional(),
})

const scrollHasExactlyOneMode = (s: {
  action: string
  to?: unknown
  by?: unknown
  until?: unknown
}) => s.action !== "scroll" || [s.to, s.by, s.until].filter((v) => v !== undefined).length === 1
const scrollModeError = { message: "scroll needs exactly one of `to`, `by` or `until`" }

/** Off-camera fields (setup, teardown, presets): IDs are optional there. */
const offCamera = { id: StepId.optional(), risky: z.boolean().optional() }

/** An off-camera action (setup, teardown, presets). */
export const Action = z
  .discriminatedUnion("action", [
    Goto.extend(offCamera),
    Click.extend(offCamera),
    Type.extend(offCamera),
    Press.extend(offCamera),
    Scroll.extend(offCamera),
    WaitFor.extend(offCamera),
    Pause.extend(offCamera),
    Expect.extend(offCamera),
  ])
  .refine(scrollHasExactlyOneMode, scrollModeError)
export type Action = z.infer<typeof Action>

/** On-camera fields: a stable ID plus presentation directives. */
const onCamera = { id: StepId, ...presentation }

/** A recorded step: an action with a stable ID and presentation fields. */
export const Step = z
  .discriminatedUnion("action", [
    Goto.extend(onCamera),
    Click.extend(onCamera),
    Type.extend(onCamera),
    Press.extend(onCamera),
    Scroll.extend(onCamera),
    WaitFor.extend(onCamera),
    Pause.extend(onCamera),
    Expect.extend(onCamera),
  ])
  .refine(scrollHasExactlyOneMode, scrollModeError)
export type Step = z.infer<typeof Step>

// ─── Setup / teardown items ───────────────────────────────────────────────────

/** Run a shared preset. Session presets run once per recording batch. */
export const PresetRef = z.strictObject({ preset: RuleName })
/** The only idempotency primitive: declarative, not a condition (§2). */
export const Ensure = z.strictObject({
  ensure: z.union([z.strictObject({ absent: Locator }), z.strictObject({ present: Locator })]),
})
export const SetupItem = z.union([PresetRef, Ensure, Action])
export type SetupItem = z.infer<typeof SetupItem>

// ─── Scenario (one per scene) ─────────────────────────────────────────────────

/** Per-scene overrides of project settings. Same validation as the project level. */
export const ScenarioOverrides = z.strictObject({
  viewport: ViewportShape.partial().optional(),
  pacing: PacingShape.partial().optional(),
  camera: CameraDefault.optional(),
})
export type ScenarioOverrides = z.infer<typeof ScenarioOverrides>

/** Does this step act on an element that `camera: target` / `emphasis` can frame? */
function hasTarget(step: Step): boolean {
  return (
    step.action === "click" ||
    step.action === "type" ||
    (step.action === "scroll" &&
      (step.to !== undefined || step.until !== undefined || step.within !== undefined))
  )
}

function usesStepTarget(step: Step): boolean {
  const camera = step.camera
  const cameraOnTarget =
    camera === "target" ||
    (typeof camera === "object" && "frame" in camera && camera.frame === "target")
  const emphasis = step.emphasis
  const emphasisOnTarget =
    emphasis === "highlight" ||
    emphasis === "spotlight" ||
    (typeof emphasis === "object" && emphasis.on === "target")
  return cameraOnTarget || emphasisOnTarget
}

function cameraUntil(step: Step): string | undefined {
  return typeof step.camera === "object" && "until" in step.camera ? step.camera.until : undefined
}

export const ScenarioBase = z
  .strictObject({
    version: z.literal(1),
    overrides: ScenarioOverrides.optional(),
    setup: z.array(SetupItem).optional(),
    steps: z.array(Step).min(1),
    teardown: z.array(Action).optional(),
  })
  .superRefine((s, ctx) => {
    // IDs are unique across setup, steps and teardown, so anchors are never ambiguous.
    // (Preset step ids are checked against these by `checkScenarioAgainstProject`.)
    const claims = claimIds(s.setup, ["setup"], ctx)
    claimIds(s.steps, ["steps"], ctx, claims)
    claimIds(s.teardown, ["teardown"], ctx, claims)

    // `camera: target` and `emphasis` on the target need a step that acts on an element.
    s.steps.forEach((step, i) => {
      if (usesStepTarget(step) && !hasTarget(step)) {
        ctx.addIssue({
          code: "custom",
          message: `"${step.action}" has no target to frame or emphasize: use a locator instead of "target"`,
          path: ["steps", i],
        })
      }
    })

    // A step that types a secret must never show its keys in the keystroke overlay.
    s.steps.forEach((step, i) => {
      if (
        step.action === "type" &&
        secretRefName(step.value) !== undefined &&
        step.keystrokes === "show"
      ) {
        ctx.addIssue({
          code: "custom",
          message: "a step typing a secret can't show keystrokes",
          path: ["steps", i, "keystrokes"],
        })
      }
    })

    // camera.until must point to a LATER step, so the framing span is never empty or inverted.
    const position = new Map(s.steps.map((step, i) => [step.id, i]))
    s.steps.forEach((step, i) => {
      const until = cameraUntil(step)
      if (until === undefined) return
      const target = position.get(until)
      if (target === undefined || target <= i) {
        ctx.addIssue({
          code: "custom",
          message: `camera.until must refer to a later step, got "${until}"`,
          path: ["steps", i, "camera", "until"],
        })
      }
    })
  })
/** A scene's scenario, with whole-document guards (forbidden keys, secret references). */
export const Scenario = guarded(ScenarioBase, [
  ["setup", "#", "value"],
  ["steps", "#", "value"],
  ["teardown", "#", "value"],
])
export type Scenario = z.infer<typeof ScenarioBase>

/** Names of the presets a scenario uses (checked against the project by `checkScenarioAgainstProject`). */
export function presetRefs(scenario: Scenario): string[] {
  return (scenario.setup ?? []).flatMap((item) => ("preset" in item ? [item.preset] : []))
}
