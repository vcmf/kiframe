// The step format as the agent reads it: one line per form of each action, as YAML flow maps the
// agent can copy. Checked against the schema (`reference.test.ts`): every action has examples, and
// every example parses as a step, so this never drifts from what the runtime accepts.
import type { Action } from "./scenario.ts"

/** Every action kind (a new one is a compile error here until it has examples). */
export type ActionKind = Action["action"]

/** What each action does, and one line per form of it (on-camera steps: each has an `id`). */
export const ACTION_REFERENCE: Record<ActionKind, { what: string; forms: string[] }> = {
  goto: {
    what: "open a page of the app (relative to it)",
    forms: ["{ id: open, action: goto, url: /projects }"],
  },
  click: {
    what: "click an element; `at` clicks at a point of it (fractions of its box: a canvas, a map)",
    forms: [
      "{ id: open-new, action: click, target: <locator> }",
      "{ id: menu, action: click, target: <locator>, button: right }",
      "{ id: edit, action: click, target: <locator>, count: 2 }",
      "{ id: add, action: click, target: <locator>, modifiers: [Shift] }",
      "{ id: dot, action: click, target: <locator>, at: { x: 0.25, y: 0.6 } }",
    ],
  },
  hover: {
    what: "move the pointer over an element (menus that open on hover)",
    forms: [
      "{ id: peek, action: hover, target: <locator> }",
      "{ id: tip, action: hover, target: <locator>, at: { x: 0.5, y: 0.1 } }",
    ],
  },
  select: {
    what: "pick an option of a native <select> (a custom dropdown is clicks)",
    forms: ["{ id: plan, action: select, target: <locator>, option: Pro }"],
  },
  drag: {
    what:
      "press on the target (at `at` within it), move, release: on another element, at a point of " +
      "one (drawing on a canvas: the same canvas, two points), or by an offset in pixels",
    forms: [
      "{ id: move-card, action: drag, target: <locator>, to: <locator> }",
      "{ id: slide, action: drag, target: <locator>, to: { dx: 120, dy: 0 } }",
      "{ id: draw, action: drag, target: <locator>, at: { x: 0.3, y: 0.3 }, to: { target: <locator>, at: { x: 0.6, y: 0.7 } } }",
    ],
  },
  upload: {
    what: "put a project asset in a file input",
    forms: [
      "{ id: avatar, action: upload, target: <locator>, file: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png }",
    ],
  },
  type: {
    what: "type text into a field (`clear` empties it first, `submit` presses Enter after)",
    forms: [
      '{ id: name, action: type, target: <locator>, value: "Q4 launch", clear: true }',
      '{ id: search, action: type, target: <locator>, value: "invoices", submit: true }',
      '{ id: pw, action: type, target: <locator>, value: "{{secrets.acme.password}}" }',
      '{ id: fill, action: type, target: <locator>, value: "Q4", instant: true }',
    ],
  },
  press: {
    what: "press keys (Enter, Escape, Tab, Mod+k: Mod is Cmd on macOS, Ctrl elsewhere)",
    forms: [
      "{ id: save, action: press, keys: Enter }",
      "{ id: palette, action: press, keys: Mod+k }",
    ],
  },
  scroll: {
    what: "scroll the page or a container: to an element, by pixels, or until an element shows",
    forms: [
      "{ id: to-pricing, action: scroll, to: <locator> }",
      "{ id: down, action: scroll, by: { y: 400 } }",
      "{ id: more, action: scroll, by: { y: 300 }, within: <locator> }",
      "{ id: find, action: scroll, until: <locator> }",
    ],
  },
  waitFor: {
    what: "wait for a condition (never a fixed sleep); `timeout` in ms for a slow page",
    forms: [
      '{ id: saved, action: waitFor, until: { text: "Saved" } }',
      "{ id: shown, action: waitFor, until: { visible: <locator> }, timeout: 20000 }",
      "{ id: gone, action: waitFor, until: { hidden: <locator> } }",
      "{ id: moved, action: waitFor, until: { url: /projects } }",
      "{ id: quiet, action: waitFor, until: { networkIdle: true } }",
    ],
  },
  expect: {
    what: "check something is true (fails the step if not)",
    forms: [
      "{ id: check, action: expect, that: { visible: <locator> } }",
      '{ id: says, action: expect, that: { text: "Welcome" } }',
      "{ id: slow, action: expect, that: { visible: <locator> }, timeout: 20000 }",
    ],
  },
  pause: {
    what: "a presentation beat (only for pacing, never to wait for the app)",
    forms: ["{ id: beat, action: pause, ms: 800 }"],
  },
}

/**
 * Fields any step can take besides its action's own (each line is checked as a step too). The
 * `id` rule: every on-camera step has one; off camera (setup, teardown) it's optional, except on a
 * step typing a secret, which always has one (its approval is keyed by it).
 */
export const COMMON_FIELDS: { field: string; example: string }[] = [
  {
    field:
      "id: kebab-case, unique in the scene (on camera always; off camera only when it types a secret)",
    example: "{ id: open-new, action: click, target: <locator> }",
  },
  {
    field:
      "risky: true on a delete, send, pay or invite (the user approves it); risky: false says a click is safe",
    example: "{ id: remove, action: click, target: <locator>, risky: true }",
  },
  {
    field: "caption: a short line shown in the video (on the steps that matter)",
    example: '{ id: open, action: click, target: <locator>, caption: "Open your projects" }',
  },
  {
    field: "hold: a beat after the step, in ms (never sped up)",
    example: "{ id: look, action: click, target: <locator>, hold: 1200 }",
  },
  {
    field:
      "cursor: hide (no cursor in the video for this step); keystrokes: show (keys pressed shown)",
    example: "{ id: shortcut, action: press, keys: Mod+k, keystrokes: show, cursor: hide }",
  },
]

/** A locator to put in the examples when they're checked (any valid one). */
export const EXAMPLE_LOCATOR = '{ by: role, role: button, name: "Save" }'

/** One action's reference, as the agent reads it. */
export function actionReference(kind: ActionKind): string {
  const { what, forms } = ACTION_REFERENCE[kind]
  return [`${kind}: ${what}`, ...forms.map((f) => `  - ${f}`)].join("\n")
}

/** The whole reference: every action, every form, then the fields every step takes. */
export function stepReference(): string {
  return [
    ...(Object.keys(ACTION_REFERENCE) as ActionKind[]).map(actionReference),
    "fields every step takes:",
    ...COMMON_FIELDS.map((c) => `  - ${c.field}`),
  ].join("\n")
}
