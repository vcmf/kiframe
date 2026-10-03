// Acting by ref: the agent points at an element of its last snapshot (`{ ref: e12 }` where a step
// takes a locator), and the studio writes the lasting locator for it (runtime `lastingLocator`)
// right before the step runs. A ref lives on the snapshotted page only: a scene's YAML never holds
// one.
import type { ElementHint } from "@kiframe/runtime"
import { parse as parseYaml, stringify } from "yaml"

/** A ref as the snapshot writes it: `e12`, or `f1e12` (a frame's: after a navigation, or an iframe's). */
export const REF = /^(f\d{1,4})?e\d{1,6}$/

/** A node of the snapshot, as its YAML key says it: `button "Save" [level=1] [ref=e8]`. */
const NODE = /^([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?((?: \[[^\]]*\])*)$/

/**
 * What a snapshot (Playwright's `mode: "ai"` YAML) says of each ref: its role, name, and its own
 * text (a node's text content: `- generic [ref=e9]: Open the board`). Read from its nodes as YAML
 * (a name with ": " or " #" is a quoted key): the page's text never names a ref.
 */
export function refsOf(snapshot: string): Map<string, ElementHint> {
  const refs = new Map<string, ElementHint>()
  const node = (key: string, content: unknown) => {
    const m = NODE.exec(key)
    const ref = m?.[3] !== undefined ? /\[ref=([a-z0-9]+)\]/.exec(m[3])?.[1] : undefined
    if (m === null || ref === undefined) return
    let name: string | undefined
    try {
      name = m[2] === undefined ? undefined : (JSON.parse(m[2]) as string)
    } catch {
      name = undefined
    }
    const text =
      typeof content === "string" || typeof content === "number" ? String(content) : undefined
    refs.set(ref, {
      role: m[1] ?? "",
      ...(name !== undefined && { name }),
      ...(text !== undefined && { text }),
    })
  }
  const walk = (items: unknown) => {
    if (!Array.isArray(items)) return
    for (const item of items as unknown[]) {
      if (typeof item === "string") node(item, undefined)
      else if (typeof item === "object" && item !== null) {
        for (const [key, children] of Object.entries(item)) {
          node(key, children)
          walk(children)
        }
      }
    }
  }
  try {
    // Every scalar as written (`~` and `.inf` are a page's text, not null and Infinity).
    walk(parseYaml(snapshot, { schema: "failsafe" }))
  } catch {
    // Not YAML (never seen): no refs, each refused as not of the last snapshot.
  }
  return refs
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
