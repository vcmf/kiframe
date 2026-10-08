// The user's hands on the agent's browser during a handover (the studio's `hand_over`): the live
// view's mouse and keys, sent to the live page through Playwright's own mouse and keyboard (it
// tracks the pointer, buttons and modifiers the runner then uses). Only while a handover is open
// (the host drops input otherwise); one event at a time, in order; whatever is held is released
// when it ends, on every page it touched. What the user typed is read from the page's fields before
// and after (what they hold, not what was inferred from keys: a page reformats a card number, a code
// goes one digit per box), the keystrokes standing in where a field can't be read: the host makes
// it known to the scrubber before the agent hears back.
import { type FormValue, longEnoughToKnow, typedValues } from "@kiframe/runtime"
import type { Page } from "playwright"
import type { LiveInput } from "../shared/ipc.ts"

/** Events waiting at most (a flood is dropped, never queued without end). */
const QUEUE_MAX = 500
/** The queued input applied at most this long after the end (a busy page: the rest dropped). */
const CLOSE_MS = 5000
/** The page's formatters settle after the last key (on blur, debounced) before the end read. */
const SETTLE_MS = 100

export class Handover {
  readonly id: string
  readonly #page: () => Page | undefined
  #queue: Promise<void> = Promise.resolve()
  #waiting = 0
  #closed = false
  /** The mouse buttons held, per page (Playwright's mouse is a page's). */
  readonly #buttons = new Map<Page, Set<"left" | "right" | "middle">>()
  /** Text typed since the last key that isn't text (a run: one field's value, most likely). */
  #run = ""
  readonly #typed: string[] = []
  /** Every text sent, in order (what a field's value must share to be the user's). */
  #sent = ""
  readonly #read: () => Promise<FormValue[]>
  readonly #before: Promise<FormValue[]>

  /**
   * `read`: the context's text fields now (`formValues`): read at once (the user's first input
   * waits for it), and again at the end.
   */
  constructor(id: string, page: () => Page | undefined, read: () => Promise<FormValue[]>) {
    this.id = id
    this.#page = page
    this.#read = read
    this.#before = read().catch(() => [])
    this.#queue = this.#before.then(() => undefined)
  }

  /**
   * One event from the live view, applied in turn (dropped once closed, or when too many wait).
   * What it types is noted now: sent, it's the user's (scrubbed even if it never reaches the page).
   */
  input(event: LiveInput): void {
    // A release always goes (dropped, a key or button would stay held).
    const release = event.kind === "mouse" && event.type === "up"
    if (this.#closed || (this.#waiting >= QUEUE_MAX && !release)) return
    this.#note(event)
    if (event.kind === "text") this.#sent += event.text
    this.#waiting++
    this.#queue = this.#queue
      .then(() => this.#apply(event))
      .catch(() => undefined)
      .finally(() => {
        this.#waiting--
      })
  }

  /**
   * Ends it: nothing more is taken, what was sent before applied, every key and button held
   * released (on each page it touched), the page left to settle, its fields read again. Gives what
   * the user typed: the fields they changed (`typedValues`), and their keystroke runs and words
   * (a value they typed then cleared, a field that couldn't be read).
   */
  async close(): Promise<string[]> {
    this.#closed = true
    // Bounded: a page too busy to take its queued input never holds the agent, or the app's close.
    await Promise.race([this.#queue, new Promise((r) => setTimeout(r, CLOSE_MS))])
    for (const [page, buttons] of this.#buttons) {
      if (page.isClosed()) continue
      for (const button of buttons) {
        await Promise.race([
          page.mouse.up({ button }).catch(() => undefined),
          new Promise((r) => setTimeout(r, 1000)),
        ])
      }
    }
    this.#buttons.clear()
    this.#endRun()
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    const before = await this.#before
    const after = await this.#read().catch(() => [])
    const words = this.#typed.flatMap((run) => run.split(/\s+/))
    return [
      ...new Set([...typedValues(before, after, this.#sent), ...this.#typed, ...words]),
    ].filter(longEnoughToKnow)
  }

  async #apply(event: LiveInput): Promise<void> {
    const page = this.#page()
    if (page === undefined || page.isClosed()) return
    if (event.kind === "text") {
      // A key or two (what a keystroke types): as keys, so the page sees them pressed (Space on a
      // checkbox, a code box moving on); longer (a paste, a composition): inserted whole.
      if ([...event.text].length <= 2) await page.keyboard.type(event.text)
      else await page.keyboard.insertText(event.text)
      return
    }
    if (event.kind === "key") {
      // Copy, cut and paste shortcuts: never (a paste comes as text, from the user's own paste).
      const command = event.modifiers.includes("Meta") || event.modifiers.includes("Control")
      if (command && ["c", "x", "v"].includes(event.key)) return
      // Pressed once with its modifiers (never held: nothing stays down after it).
      await page.keyboard.press([...event.modifiers, event.key].join("+"))
      return
    }
    // A point on the live view (0–1 of the frame), on the page's own CSS pixels now.
    const size =
      page.viewportSize() ??
      (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    const x = event.x * size.width
    const y = event.y * size.height
    if (event.kind === "wheel") {
      await page.mouse.move(x, y)
      await page.mouse.wheel(event.dx, event.dy)
      return
    }
    await page.mouse.move(x, y)
    if (event.type === "down") {
      held(this.#buttons, page).add(event.button)
      await page.mouse.down({ button: event.button, clickCount: event.clickCount })
    } else if (event.type === "up") {
      held(this.#buttons, page).delete(event.button)
      await page.mouse.up({ button: event.button, clickCount: event.clickCount })
    }
  }

  /** Text typed, by runs: a key that isn't text, or a click, ends one (Backspace edits it). */
  #note(event: LiveInput): void {
    if (event.kind === "text") this.#run += event.text
    else if (event.kind === "key") {
      if (event.key === "Backspace" && event.modifiers.length === 0) {
        this.#run = [...this.#run].slice(0, -1).join("")
      } else this.#endRun()
    } else if (event.kind === "mouse" && event.type === "down") this.#endRun()
  }

  #endRun(): void {
    if (this.#run.trim() !== "") this.#typed.push(this.#run.trim())
    this.#run = ""
  }
}

/** A page's set of what's held (made on first use). */
function held<T>(of: Map<Page, Set<T>>, page: Page): Set<T> {
  let set = of.get(page)
  if (set === undefined) of.set(page, (set = new Set()))
  return set
}
