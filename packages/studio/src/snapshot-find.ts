import { normalizeText } from "@kiframe/runtime"

/** Lines of a subtree shown under each match (its link's URL, a cell's text, a list's items). */
const BELOW = 6
/** Under a match that spans its children (a paragraph's sentence over a link): more of them. */
const BELOW_BLOCK = 20
/** A block's text is matched whole up to this long (a paragraph, a list item; never a page). */
const BLOCK_MAX = 8000

/** A line's own words: without its refs and states (`[ref=e12]`, `[level=2]`), quotes unescaped. */
const wordsOf = (line: string) => line.replace(/ \[[a-z-]+(=[^\]]*)?\]/g, "").replace(/\\"/g, '"')

/**
 * What a line shows a reader: a name and a value (`- link "four assists"` → four assists,
 * `- text: and won` → and won), never its role, refs or URL.
 */
function shownOf(line: string): string {
  // Refs and states dropped, quotes still escaped (a name may hold `\"`).
  const words = line
    .replace(/ \[[a-z-]+(=[^\]]*)?\]/g, "")
    .trim()
    .replace(/^- /, "")
  if (words.startsWith("/")) return "" // `/url:`, `/placeholder:`: properties, not text
  // A key holding ": " or " #" comes single-quoted (`'link "Step 1: install"'`), `''` for `'`.
  const quoted = /^'((?:[^']|'')*)'(:.*)?$/.exec(words)
  if (quoted !== null)
    return shownOf(`- ${(quoted[1] ?? "").replace(/''/g, "'")}${quoted[2] ?? ""}`)
  const text = /^text: (.*)$/.exec(words)
  if (text !== null) return unescape(unquote(text[1] ?? ""))
  // A role, maybe a name, maybe `:` and a value (`:` alone: its children follow).
  const m = /^[a-z]+(?: "((?:[^"\\]|\\.)*)")?(?::(?: (.*))?)?$/.exec(words)
  if (m === null) return ""
  return [unescape(m[1] ?? ""), unescape(unquote(m[2] ?? ""))].filter((p) => p !== "").join(" ")
}

const unescape = (s: string) => s.replace(/\\(.)/g, "$1")

/**
 * A block's parts read as one text: a space between them (the snapshot trims each line), but none
 * before punctuation that runs on after a link ("<a>four assists</a>, becoming") nor after an
 * opening bracket (a quote may open or close: spaced as the lines are).
 */
function joinShown(parts: readonly string[]): string {
  let out = ""
  for (const part of parts) {
    if (part === "") continue
    const glued = out === "" || /^[,.;:!?)\]}%]/.test(part) || /[([{]$/.test(out)
    out += glued ? part : ` ${part}`
  }
  return out
}

const unquote = (s: string) => (/^".*"$/.test(s) ? s.slice(1, -1) : s)

/** What `findInSnapshot` found: the parts shown, and whether only near matches were. */
export interface Found {
  text: string
  /** No part holds the phrase: these hold every one of its words. */
  near: boolean
}

/**
 * The parts of an accessibility snapshot that mention `query`, as a reader would look: case,
 * dashes, quotes and spaces don't matter, and a phrase may run over a block's children (a
 * paragraph's sentence over a link). Each match is the deepest element holding it, shown with its
 * ancestors (where it is on the page) and the start of its subtree, in page order, `…` where lines
 * are left out. A line's own words count too (a URL, a role). With no match, the deepest blocks
 * holding every word of a query of several words (`near`). A long page's snapshot is cut for the
 * agent; this reaches past the cut (its refs are the whole snapshot's). Empty: nothing.
 */
export function findInSnapshot(text: string, query: string): Found {
  const lines = text.split("\n")
  const n = lines.length
  const depth = lines.map((l) => l.length - l.trimStart().length)
  // Each line's parent (the nearest line above it that's less indented), in one pass.
  const parent: number[] = []
  const children: number[][] = lines.map(() => [])
  const open: number[] = []
  for (let i = 0; i < n; i++) {
    while (open.length > 0 && depth[open.at(-1)!]! >= depth[i]!) open.pop()
    const p = open.at(-1) ?? -1
    parent.push(p)
    if (p >= 0) children[p]!.push(i)
    open.push(i)
  }
  const own = lines.map((l) => normalizeText(wordsOf(l)))
  // Each block's text as read, children in order (none past BLOCK_MAX: a page isn't a block).
  const block: (string | undefined)[] = new Array<string | undefined>(n)
  for (let i = n - 1; i >= 0; i--) {
    const parts = [normalizeText(shownOf(lines[i]!))]
    let length = parts[0]!.length
    let fits = true
    for (const c of children[i]!) {
      const b = block[c]
      // Past the limit: no need to join the rest (a page isn't a block).
      if (b === undefined || (length += b.length + 1) > BLOCK_MAX) {
        fits = false
        break
      }
      parts.push(b)
    }
    block[i] = fits ? joinShown(parts) : undefined
  }
  const deepest = (holds: (i: number) => boolean): number[] => {
    const hit = lines.map((_, i) => holds(i))
    return hit.flatMap((h, i) => (h && !children[i]!.some((c) => hit[c]) ? [i] : []))
  }
  const needle = normalizeText(query)
  let near = false
  let found = deepest((i) => own[i]!.includes(needle) || block[i]?.includes(needle) === true)
  if (found.length === 0) {
    // The phrase as written, spaces aside: the snapshot's lines are trimmed, so text that runs on
    // after a link ("<a>Nadal</a>'s", "<a>COVID</a>-19") reads with a space the page doesn't show.
    const tight = needle.replace(/ /g, "")
    found = deepest((i) => block[i]?.replace(/ /g, "").includes(tight) === true)
  }
  const words = needle.split(" ").filter((w) => w !== "")
  if (found.length === 0 && words.length > 1) {
    near = true
    found = deepest((i) => {
      const b = block[i]
      return b !== undefined && words.every((w) => b.includes(w))
    })
  }
  const keep = new Set<number>()
  for (const i of found) {
    // Its ancestors, up to one already kept (its own ancestors are too).
    for (let j = parent[i]!; j >= 0 && !keep.has(j); j = parent[j]!) keep.add(j)
    keep.add(i)
    // A block matched over its children: enough of them to read it.
    const below = own[i]!.includes(needle) ? BELOW : BELOW_BLOCK
    for (let j = i + 1; j < n && j <= i + below && depth[j]! > depth[i]!; j++) keep.add(j)
  }
  const out: string[] = []
  let last = -1
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`${" ".repeat(depth[i]!)}…`)
    out.push(lines[i]!)
    last = i
  }
  if (out.length > 0 && last < n - 1) out.push("…")
  return { text: out.join("\n"), near }
}
