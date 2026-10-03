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
    what: "wait for a condition (never a fixed sleep)",
    forms: [
      '{ id: saved, action: waitFor, until: { text: "Saved" } }',
      "{ id: shown, action: waitFor, until: { visible: <locator> } }",
      "{ id: gone, action: waitFor, until: { hidden: <locator> } }",
      "{ id: moved, action: waitFor, until: { url: /projects } }",
    ],
  },
  expect: {
    what: "check something is true (fails the step if not)",
    forms: [
      "{ id: check, action: expect, that: { visible: <locator> } }",
      '{ id: says, action: expect, that: { text: "Welcome" } }',
    ],
  },
  pause: {
    what: "a presentation beat (only for pacing, never to wait for the app)",
    forms: ["{ id: beat, action: pause, ms: 800 }"],
  },
}

/** A locator to put in the examples when they're checked (any valid one). */
export const EXAMPLE_LOCATOR = '{ by: role, role: button, name: "Save" }'

/** One action's reference, as the agent reads it. */
export function actionReference(kind: ActionKind): string {
  const { what, forms } = ACTION_REFERENCE[kind]
  return [`${kind}: ${what}`, ...forms.map((f) => `  - ${f}`)].join("\n")
}

/** The whole reference: every action, every form. */
export function stepReference(): string {
  return (Object.keys(ACTION_REFERENCE) as ActionKind[]).map(actionReference).join("\n")
}
