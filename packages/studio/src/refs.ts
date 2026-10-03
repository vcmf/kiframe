// Acting by ref: the agent points at an element of its last snapshot (`{ ref: e12 }` where a step
// takes a locator), and the studio writes the lasting locator for it (runtime `lastingLocator`)
// right before the step runs. A ref lives on the snapshotted page only: a scene's YAML never holds
// one.
import { collapse as collapseText, type ElementHint, VALUE_ROLES } from "@kiframe/runtime"
import { parse as parseYaml, stringify } from "yaml"

/** A ref as the snapshot writes it: `e12`, or `f1e12` (a frame's: after a navigation, or an iframe's). */
export const REF = /^(f\d{1,4})?e\d{1,6}$/

/**
 * A node of the snapshot, as its YAML key says it: `button "Save" [level=1] [ref=e8]`; a name that
 * starts and ends with "/" is written unquoted (`link /docs/ [ref=e9]`).
 */
const NODE = /^([a-z]+)(?: ("(?:[^"\\]|\\.)*"|\/(?:.*\/)?))?((?: \[[^\]]*\])*)$/

/** What a snapshot says of a ref's node, and whether it's inside an iframe (under an iframe node). */
export interface SnapshotNode extends ElementHint {
  inFrame: boolean
  /**
   * The nearest ancestor that says what it is (a name or text of its own): a reused row's
   * checkbox, or its "Delete", keeps its ref and its name while the row reads "Buy eggs" for
   * "Buy milk"; the row tells them apart.
   */
  context?: string | undefined
}

/**
 * What a snapshot (Playwright's `mode: "ai"` YAML) says of each ref: its role, name, and its own
 * text (its scalar content, or its `text:` children: `- generic [ref=e9]: Open the board`). Read
 * from its nodes as YAML (a name with ": " or " #" is a quoted key), every scalar as written: the
 * page's text never names a ref. Undefined: it isn't a snapshot Playwright wrote.
 */
export function refsOf(snapshot: string): Map<string, SnapshotNode> | undefined {
  const refs = new Map<string, SnapshotNode>()
  /** The node (if it's one with a ref), and what it says of itself for its children's context. */
  const node = (
    key: string,
    content: unknown,
    inFrame: boolean,
    context: string | undefined,
  ): { iframe: boolean; says: string | undefined } => {
    const m = NODE.exec(key)
    const ref = m?.[3] !== undefined ? /\[ref=([a-z0-9]+)\]/.exec(m[3])?.[1] : undefined
    if (m === null || ref === undefined) return { iframe: false, says: undefined }
    let name: string | undefined
    try {
      const quoted = m[2]
      name =
        quoted === undefined
          ? undefined
          : quoted.startsWith('"')
            ? (JSON.parse(quoted) as string)
            : quoted
    } catch {
      name = undefined
    }
    const text = ownText(content)
    const role = m[1] ?? ""
    refs.set(ref, {
      role,
      ...(name !== undefined && { name }),
      ...(text !== undefined && { text }),
      inFrame,
      ...(context !== undefined && { context }),
    })
    // A field says what it is by its name, never its value (which steps change).
    const own = VALUE_ROLES.has(role) ? undefined : text
    const says =
      name !== undefined || own !== undefined
        ? JSON.stringify([role, name ?? "", collapse(own) ?? ""])
        : undefined
    return { iframe: role === "iframe", says }
  }
  const walk = (items: unknown, inFrame: boolean, context: string | undefined) => {
    if (!Array.isArray(items)) return
    for (const item of items as unknown[]) {
      if (typeof item === "string") node(item, undefined, inFrame, context)
      else if (typeof item === "object" && item !== null) {
        for (const [key, children] of Object.entries(item)) {
          // Under an iframe node: the iframe's own elements.
          const { iframe, says } = node(key, children, inFrame, context)
          walk(children, inFrame || iframe, says ?? context)
        }
      }
    }
  }
  try {
    // Every scalar as written (`~` and `.inf` are a page's text, not null and Infinity).
    walk(parseYaml(snapshot, { schema: "failsafe" }), false, undefined)
  } catch {
    return undefined
  }
  return refs
}

/** A node's own text: its scalar content, or its `text:` children joined (never its elements'). */
function ownText(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return undefined
  const parts = (content as unknown[]).flatMap((c) =>
    typeof c === "object" && c !== null && typeof (c as { text?: unknown }).text === "string"
      ? [(c as { text: string }).text]
      : [],
  )
  return parts.length > 0 ? parts.join(" ") : undefined
}

const collapse = (text: string | undefined) => (text === undefined ? undefined : collapseText(text))

/**
 * Whether a fresh snapshot's node (same document, same ref) is still the element the agent saw:
 * Playwright gives a node a new ref when its role or name changes, so its role and name are
 * checked as a backstop; its context (the row it's in) must say the same; and the text of a
 * nameless node is what it is (a list row's "Buy milk"): never a field's, whose text is its value
 * (what the agent's own steps type).
 */
type Said = Pick<SnapshotNode, "role" | "name" | "text" | "context">

export function sameNode(saw: Said, now: Said): boolean {
  if (saw.role !== now.role || saw.name !== now.name) return false
  // In the same place: what its nearest self-describing ancestor says (a row's text).
  if (saw.context !== now.context) return false
  if (saw.name !== undefined || VALUE_ROLES.has(saw.role)) return true
  return collapse(saw.text) === collapse(now.text)
}

/** The deepest a step is walked (a step is a few levels; far deeper is no step). */
const MAX_DEPTH = 64

/**
 * Whether a value refers to itself (a YAML alias inside what it names: `&a { x: *a }`), or nests
 * past any step's depth: no walk over it is safe. An alias used twice side by side is no cycle.
 */
export function isCyclic(value: unknown, ancestors = new Set<object>()): boolean {
  if (typeof value !== "object" || value === null) return false
  if (ancestors.has(value) || ancestors.size >= MAX_DEPTH) return true
  ancestors.add(value)
  const cyclic = Object.values(value).some((v) => isCyclic(v, ancestors))
  ancestors.delete(value)
  return cyclic
}

/** A ref in a value, where it is (its path), and what else it says beside `ref`. */
export interface RefAt {
  path: (string | number)[]
  ref: string
  extra: string[]
}

/** Every ref in a value (no cycles: see `isCyclic`): an object with a string `ref`. */
export function refsAt(value: unknown, path: (string | number)[] = []): RefAt[] {
  if (typeof value !== "object" || value === null) return []
  const r = (value as { ref?: unknown }).ref
  if (!Array.isArray(value) && typeof r === "string") {
    return [{ path, ref: r, extra: Object.keys(value).filter((k) => k !== "ref") }]
  }
  return Object.entries(value).flatMap(([k, v]) =>
    refsAt(v, [...path, Array.isArray(value) ? Number(k) : k]),
  )
}

/** A copy of a value (no cycles) with the value at a path replaced. */
export function withAt(value: unknown, path: (string | number)[], put: unknown): unknown {
  if (path.length === 0) return put
  const [head, ...rest] = path
  if (Array.isArray(value)) {
    return value.map((v, i) => (i === head ? withAt(v, rest, put) : (v as unknown)))
  }
  const object = value as Record<string, unknown>
  return { ...object, [head as string]: withAt(object[head as string], rest, put) }
}

/** A step as the agent writes it in the YAML: one flow line. */
export function asWritten(step: unknown): string {
  return stringify(step, { collectionStyle: "flow", lineWidth: 0 }).trim()
}
