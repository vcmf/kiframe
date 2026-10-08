import type { BrowserContext, CDPSession } from "playwright"
import type { Rare, Snapshot } from "./look.ts"

// What the user typed during a handover, read from what the page's fields hold (never inferred
// from keystrokes alone: a page reformats a card number, an arrow key edits, a code goes one digit
// per box). Read through the browser's own snapshot (DOMSnapshot: native values, no page code, closed
// shadow roots too), in every page of the context and every out-of-process frame (its own session).

/** A text field's value at one moment: keyed by its frame and node (stable for its lifetime). */
export interface FormValue {
  key: string
  value: string
  /** Its place among the fields of its document (a code's boxes are consecutive). */
  order: number
  doc: string
}

/** Input types that never show typed text (any other does, an unknown one too, as the browser draws
 *  it); a password's: dots on screen, and the vault's. */
const NOT_TEXT = new Set([
  "password",
  "hidden",
  "checkbox",
  "radio",
  "submit",
  "button",
  "reset",
  "image",
  "file",
  "range",
  "color",
])
/** One read: this long at most (then incomplete: the keystrokes stand in). */
const READ_MS = 3000

/** Every text field's value in the context now (a part that can't be read: left out). */
export async function formValues(context: BrowserContext): Promise<FormValue[]> {
  // The page's own session (its process's documents), and each frame's: only an out-of-process
  // frame has one (its documents are in no other snapshot). All read side by side.
  const opens = context
    .pages()
    .filter((page) => !page.isClosed())
    .flatMap((page) => [
      () => context.newCDPSession(page),
      ...page
        .frames()
        .filter((frame) => frame !== page.mainFrame())
        .map((frame) => () => context.newCDPSession(frame)),
    ])
  const snapshots = await Promise.all(
    opens.map(async (open) => {
      let session: CDPSession
      try {
        session = await open()
      } catch {
        return undefined // an in-process frame: in its page's snapshot
      }
      try {
        return await bounded(
          session.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }) as Promise<Snapshot>,
        )
      } catch {
        return undefined
      } finally {
        void session.detach().catch(() => undefined)
      }
    }),
  )
  const values: FormValue[] = []
  for (const snapshot of snapshots) {
    if (snapshot !== undefined) values.push(...fieldsIn(snapshot, values.length))
  }
  return values
}

/** The text fields of a snapshot (inputs of text types, textareas) with their values. */
export function fieldsIn(snapshot: Snapshot, from = 0): FormValue[] {
  const str = (i: number | undefined) =>
    i === undefined || i < 0 ? "" : (snapshot.strings[i] ?? "")
  const out: FormValue[] = []
  for (const doc of snapshot.documents) {
    const frame = str(doc.frameId)
    const rare = (r: Rare<number> | undefined) => {
      const m = new Map<number, string>()
      for (const [k, node] of (r?.index ?? []).entries()) m.set(node, str(r!.value[k]))
      return m
    }
    const inputs = rare(doc.nodes.inputValue)
    const texts = rare(doc.nodes.textValue)
    for (const [n, nameIndex] of (doc.nodes.nodeName ?? []).entries()) {
      const name = str(nameIndex).toUpperCase()
      let value: string | undefined
      if (name === "INPUT") {
        const flat = doc.nodes.attributes?.[n] ?? []
        let type = ""
        for (let i = 0; i + 1 < flat.length; i += 2) {
          if (str(flat[i]).toLowerCase() === "type") type = str(flat[i + 1]).toLowerCase()
        }
        if (!NOT_TEXT.has(type)) value = inputs.get(n) ?? ""
      } else if (name === "TEXTAREA") {
        value = texts.get(n) ?? inputs.get(n) ?? ""
      }
      if (value === undefined) continue
      const id = doc.nodes.backendNodeId?.[n] ?? n
      out.push({ key: `${frame}:${id}`, value, order: from + out.length, doc: frame })
    }
  }
  return out
}

/** A read, given up after `READ_MS` (a hung page: the keystrokes stand in). */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), READ_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Letters and digits only, lower case (a value as typed and as the page shows it compare so). */
function plain(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")
}

/** Whether a typed value is long enough to know (3 only for digits: a CVV; else 4: ordinary text). */
export function longEnoughToKnow(value: string): boolean {
  const v = value.trim()
  return /^\d+$/.test(v) ? v.length >= 3 : [...v].length >= 4
}

/**
 * The values the user typed, from the fields before and after a handover and the text they sent:
 * a field that changed (or appeared) counts only if it holds what they typed (a run of 3 of their
 * characters, or a 1–2 character value they typed: a code's box), never a value the page filled in
 * itself; consecutive one- or two-character fields (3 or more) joined (a code split across boxes).
 */
export function typedValues(before: FormValue[], after: FormValue[], typed: string): string[] {
  const was = new Map(before.map((f) => [f.key, f.value]))
  const sent = plain(typed)
  const theirs = (value: string) => {
    const p = plain(value)
    if (p === "") return false
    if (p.length <= 2) return sent.includes(p)
    for (let i = 0; i + 3 <= p.length; i++) if (sent.includes(p.slice(i, i + 3))) return true
    return false
  }
  const changed = after.filter(
    (f) => f.value.trim() !== "" && was.get(f.key) !== f.value && theirs(f.value),
  )
  const out = new Set<string>()
  for (const f of changed) if (longEnoughToKnow(f.value)) out.add(f.value.trim())
  // A code across boxes: consecutive short fields of one document, joined.
  let run: FormValue[] = []
  const flush = () => {
    if (run.length >= 3) out.add(run.map((f) => f.value.trim()).join(""))
    run = []
  }
  for (const f of changed) {
    const prev = run.at(-1)
    const short = [...f.value.trim()].length <= 2
    if (!short || (prev !== undefined && (prev.doc !== f.doc || prev.order + 1 !== f.order))) {
      flush()
    }
    if (short) run.push(f)
  }
  flush()
  return [...out]
}
