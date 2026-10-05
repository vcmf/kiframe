/** Lines of a subtree shown under each match (its link's URL, a cell's text, a list's items). */
const BELOW = 6

/** A line's own words: without its refs and states (`[ref=e12]`, `[level=2]`), quotes unescaped. */
const wordsOf = (line: string) => line.replace(/ \[[a-z-]+(=[^\]]*)?\]/g, "").replace(/\\"/g, '"')

/**
 * The parts of an accessibility snapshot that mention `query` (case-insensitive, in each line's
 * words: names, text, URLs, never its refs): each matching line with its ancestors (where it is
 * on the page) and the start of its subtree, in page order, `…` where lines are left out. A long
 * page's snapshot is cut for the agent; this reaches past the cut (its refs are the whole
 * snapshot's). Empty: nothing matches.
 */
export function findInSnapshot(text: string, query: string): string {
  const lines = text.split("\n")
  const depth = lines.map((l) => l.length - l.trimStart().length)
  // Each line's parent (the nearest line above it that's less indented), in one pass.
  const parent: number[] = []
  const open: number[] = []
  for (let i = 0; i < lines.length; i++) {
    while (open.length > 0 && depth[open.at(-1)!]! >= depth[i]!) open.pop()
    parent.push(open.at(-1) ?? -1)
    open.push(i)
  }
  const needle = query.trim().toLowerCase()
  const keep = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    if (!wordsOf(lines[i]!).toLowerCase().includes(needle)) continue
    // Its ancestors, up to one already kept (its own ancestors are too).
    for (let j = parent[i]!; j >= 0 && !keep.has(j); j = parent[j]!) keep.add(j)
    keep.add(i)
    for (let j = i + 1; j < lines.length && j <= i + BELOW && depth[j]! > depth[i]!; j++)
      keep.add(j)
  }
  const out: string[] = []
  let last = -1
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`${" ".repeat(depth[i]!)}…`)
    out.push(lines[i]!)
    last = i
  }
  if (out.length > 0 && last < lines.length - 1) out.push("…")
  return out.join("\n")
}
