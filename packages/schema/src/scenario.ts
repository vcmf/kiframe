import * as z from "zod"
import {
  claimIds,
  CssSelector,
  isRelativeUrl,
  Ms,
  RectTuple,
  secretRefName,
  SceneFilePath,
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
  fingerprint: SceneFilePath.optional(),
  /** Pick the n-th VISIBLE match (0-based) when the locator matches several elements. Hidden matches don't count. */
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

/**
 * A grounded target as a stable string (SECRETS-DESIGN §3 A1): what a secret approval binds. Its
 * healing metadata (`intent`, `fingerprint`) is left out; keys sorted; the default `exact: false`
 * dropped, so the same target written two ways is the same string.
 */
export function canonicalTarget(target: GroundedTarget): string {
  const { intent: _intent, fingerprint: _fingerprint, ...rest } = target
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value === null || typeof value !== "object") return value
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v === undefined || (key === "exact" && v === false)) continue
      out[key] = stable(v)
    }
    return out
  }
  return JSON.stringify(stable(rest))
}

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
  /**
   * Relative to the environment's URL: `goto` never leaves the target app. No whitespace or control
   * characters (the URL parser would silently drop them). Credentials are impossible: a relative
   * URL stays on the environment's origin, which has none.
   */
  url: z
    .string()
    .min(1)
    .refine((u) => [...u].every((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) !== 0x7f), {
      message: "goto URL can't contain spaces or control characters",
    })
    .refine(isRelativeUrl, {
      message: "goto URL must be relative to the environment (e.g. `/projects`)",
    }),
})
/** Moves the pointer over the target (menus and buttons that only show on hover). */
const Hover = z.strictObject({ action: z.literal("hover"), target: Target })
/** A native `<select>` (custom dropdowns are clicks): the option's label or value. */
const Select = z.strictObject({
  action: z.literal("select"),
  target: Target,
  option: z.string().min(1).max(500),
})
/** Drag the target to another element, or by an offset in CSS pixels (sliders, kanban, reorder). */
const Drag = z.strictObject({
  action: z.literal("drag"),
  target: Target,
  to: z.union([
    Target,
    z.strictObject({
      dx: z.number().int().min(-10_000).max(10_000),
      dy: z.number().int().min(-10_000).max(10_000),
    }),
  ]),
})
/** A project asset (content-addressed, `assets/<sha256>.<ext>`). */
export const UploadFile = z
  .string()
  .regex(/^[0-9a-f]{64}\.[a-z0-9]{1,10}$/, "an upload is a project asset: <sha256>.<ext>")
/** Put a project asset in a file input (or the chooser a button opens): the OS dialog isn't filmed. */
const Upload = z.strictObject({ action: z.literal("upload"), target: Target, file: UploadFile })
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

/**
 * A step typing a secret targets exactly one element, as the user approved it (SECRETS-DESIGN §3
 * A2): a grounded locator with no fallbacks and no `nth` (either could reach another field).
 */
const secretTargetIsExact = (s: { action: string; value?: unknown; target?: unknown }) =>
  s.action !== "type" ||
  typeof s.value !== "string" ||
  secretRefName(s.value) === undefined ||
  (typeof s.target === "object" &&
    s.target !== null &&
    "by" in s.target &&
    !("fallbacks" in s.target && s.target.fallbacks !== undefined) &&
    !("nth" in s.target && s.target.nth !== undefined))
const secretTargetError = {
  message: "a step typing a secret needs one exact grounded target: no fallbacks, no `nth`",
  path: ["target"],
}

/** Whether an action types a secret (its step then needs an id: approvals are keyed by it). */
export function typesSecret(a: { action: string; value?: unknown }): boolean {
  return a.action === "type" && typeof a.value === "string" && secretRefName(a.value) !== undefined
}

/** Off-camera fields (setup, teardown, presets): IDs are optional there. */
const offCamera = { id: StepId.optional(), risky: z.boolean().optional() }

/** An off-camera action (setup, teardown, presets). */
export const Action = z
  .discriminatedUnion("action", [
    Goto.extend(offCamera),
    Click.extend(offCamera),
    Hover.extend(offCamera),
    Select.extend(offCamera),
    Drag.extend(offCamera),
    Upload.extend(offCamera),
    Type.extend(offCamera),
    Press.extend(offCamera),
    Scroll.extend(offCamera),
    WaitFor.extend(offCamera),
    Pause.extend(offCamera),
    Expect.extend(offCamera),
  ])
  .refine(scrollHasExactlyOneMode, scrollModeError)
  .refine(secretTargetIsExact, secretTargetError)
export type Action = z.infer<typeof Action>

/** On-camera fields: a stable ID plus presentation directives. */
const onCamera = { id: StepId, ...presentation }

/** A recorded step: an action with a stable ID and presentation fields. */
export const Step = z
  .discriminatedUnion("action", [
    Goto.extend(onCamera),
    Click.extend(onCamera),
    Hover.extend(onCamera),
    Select.extend(onCamera),
    Drag.extend(onCamera),
    Upload.extend(onCamera),
    Type.extend(onCamera),
    Press.extend(onCamera),
    Scroll.extend(onCamera),
    WaitFor.extend(onCamera),
    Pause.extend(onCamera),
    Expect.extend(onCamera),
  ])
  .refine(scrollHasExactlyOneMode, scrollModeError)
  .refine(secretTargetIsExact, secretTargetError)
export type Step = z.infer<typeof Step>

// ─── Setup / teardown items ───────────────────────────────────────────────────

/** Run a shared preset. Session presets run once per recording batch. */
export const PresetRef = z.strictObject({ preset: RuleName })
/** The only idempotency primitive: declarative, not a condition (§2). */
export const Ensure = z.strictObject({
  ensure: z.union([z.strictObject({ absent: Locator }), z.strictObject({ present: Locator })]),
})
export type Ensure = z.infer<typeof Ensure>
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
    step.action === "select" ||
    step.action === "drag" ||
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

/** Unguarded: internal only, use the guarded export. */
const ScenarioBase = z
  .strictObject({
    version: z.literal(1),
    overrides: ScenarioOverrides.optional(),
    setup: z.array(SetupItem).optional(),
    steps: z.array(Step).min(1),
    teardown: z.array(Action).optional(),
  })
  .superRefine((s, ctx) => {
    // Off-camera steps typing a secret need an id too: approvals are keyed by it (§3 A1).
    for (const [phase, items] of [
      ["setup", s.setup ?? []],
      ["teardown", s.teardown ?? []],
    ] as const) {
      for (const [i, item] of items.entries()) {
        if ("action" in item && typesSecret(item) && item.id === undefined) {
          ctx.addIssue({
            code: "custom",
            message: "a step typing a secret needs an id (its approval refers to it)",
            path: [phase, i, "id"],
          })
        }
      }
    }
    // IDs are unique across setup, steps and teardown, so anchors are never ambiguous.
    // (Preset step ids are checked against these by `checkScenarioAgainstProject`.)
    const claims = claimIds(s.setup, ["setup"], ctx)
    claimIds(s.steps, ["steps"], ctx, claims)
    claimIds(s.teardown, ["teardown"], ctx, claims)

    const position = new Map(s.steps.map((step, i) => [step.id, i]))
    s.steps.forEach((step, i) => {
      // `camera: target` and `emphasis` on the target need a step that acts on an element.
      if (usesStepTarget(step) && !hasTarget(step)) {
        ctx.addIssue({
          code: "custom",
          message: `"${step.action}" has no target to frame or emphasize: use a locator instead of "target"`,
          path: ["steps", i],
        })
      }
      // A step that types a secret must never show its keys in the keystroke overlay.
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
      // camera.until must point to a LATER step, so the framing span is never empty or inverted.
      const until = cameraUntil(step)
      const target = until === undefined ? undefined : position.get(until)
      if (until !== undefined && (target === undefined || target <= i)) {
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
