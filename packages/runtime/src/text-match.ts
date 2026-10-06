// Text as a reader sees it, for matching what the agent wrote against a page: case, dashes,
// quotes, spaces and invisible marks don't matter ("2010–2013" is "2010-2013"; a non-breaking
// space is a space; an accent typed as two characters is one). Matched in Node, never in the page
// (SECRETS-DESIGN I1).
import { valuePattern } from "./scanner.ts"

const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g
const SINGLE_QUOTES = /[\u2018-\u201B\u2032\uFF07\u02BC\u00B4]/g
const DOUBLE_QUOTES = /[\u201C-\u201F\u2033\uFF02]/g
/**
 * Marks that show nothing: zero-widths, direction marks and controls (Wikipedia puts them next to
 * names in other scripts), the soft hyphen, word joiners, variation selectors (❤️ is ❤), the
 * combining grapheme joiner.
 */
const INVISIBLE =
  /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\u034F|\uFE0E|\uFE0F/g

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** A text's characters (grapheme clusters); plain ASCII (most text) without the segmenter. */
function* characters(data: string): Iterable<{ segment: string; index: number }> {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(data)) {
    for (let index = 0; index < data.length; index++) yield { segment: data[index]!, index }
    return
  }
  yield* segmenter.segment(data)
}

/** One character as a reader sees it, as matched: "" when it shows nothing, " " for a space. */
function foldCluster(cluster: string): string {
  // Plain ASCII (most text): only its case.
  if (cluster.length === 1 && cluster.charCodeAt(0) < 0x80) {
    return /\s/.test(cluster) ? " " : cluster.toLowerCase()
  }
  // Quote-likes first: NFKC would turn ´ into a space and an accent.
  const visible = cluster.replace(INVISIBLE, "").replace(SINGLE_QUOTES, "'")
  if (visible === "") return ""
  if (/^\s+$/.test(visible)) return " "
  return visible
    .normalize("NFKC")
    .replace(DASHES, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .toLowerCase()
    .replace(/\u00DF/g, "ss")
}

/** Where a unit of the matched text came from: a character (cluster) of one piece. */
export interface TextPosition {
  piece: number
  /** The character's offset in its piece, and its length there (UTF-16 units). */
  offset: number
  length: number
}

/** Pieces of text joined as a reader sees them, each UTF-16 unit traced to its source. */
export interface JoinedText {
  text: string
  from: TextPosition[]
  /** Whether a unit is the first of its character (a match never starts or ends mid-character). */
  starts: boolean[]
}

/**
 * Pieces of text (a page's text nodes, in rendered order) as one matched text. Pieces are joined
 * as they render: a space where whitespace is, and before a piece that starts a new line
 * (`breaks[i]`: after a `<br>`, at a block's edge).
 */
export function joinPieces(pieces: readonly string[], breaks: readonly boolean[] = []): JoinedText {
  let text = ""
  const from: TextPosition[] = []
  const starts: boolean[] = []
  let space = true // no leading space
  const add = (folded: string, at: TextPosition) => {
    text += folded
    for (let unit = 0; unit < folded.length; unit++) {
      from.push(at)
      starts.push(unit === 0)
    }
  }
  for (const [piece, data] of pieces.entries()) {
    if (breaks[piece] === true && !space) {
      // Before the piece's first character (a caret there lands on that character, not here).
      add(" ", { piece, offset: -1, length: 0 })
      space = true
    }
    for (const { segment, index } of characters(data)) {
      const folded = foldCluster(segment)
      if (folded === "") continue
      if (folded === " ") {
        if (!space) add(" ", { piece, offset: index, length: segment.length })
        space = true
      } else {
        add(folded, { piece, offset: index, length: segment.length })
        space = false
      }
    }
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1)
    from.pop()
    starts.pop()
  }
  return { text, from, starts }
}

/** A text as matched: folded the same way as a page's, runs of whitespace one space, trimmed. */
export function normalizeText(text: string): string {
  return joinPieces([text]).text
}

/**
 * The first unit of `joined` at or after a position in its pieces (a caret's), or its length when
 * none is: positions compare in matched-text space (a caret in collapsed whitespace, or at the end
 * of one node vs the start of the next, lands on the same unit).
 */
export function unitAt(joined: JoinedText, piece: number, offset: number): number {
  const at = joined.from.findIndex(
    (f) => f.piece > piece || (f.piece === piece && f.offset >= offset),
  )
  return at === -1 ? joined.text.length : at
}

/** Every place `needle` (as matched) starts in `haystack` (already matched), overlapping or not. */
export function occurrences(haystack: string, needle: string): number[] {
  const at: number[] = []
  if (needle === "") return at
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) at.push(i)
  return at
}

/**
 * Which units of `joined` show a known secret value, matched as the scanner matches (its own
 * pattern: whitespace-tolerant, values under 6 characters as whole words), on the folded text.
 */
function knownValueUnits(joined: JoinedText, knownValues: Iterable<string>): Uint8Array {
  const masked = new Uint8Array(joined.text.length)
  for (const value of knownValues) {
    const v = normalizeText(value)
    if (v === "") continue
    for (const m of joined.text.matchAll(valuePattern(v, "gu"))) {
      masked.fill(1, m.index, m.index + m[0].length)
    }
  }
  return masked
}

/** Whether `joined` shows any known secret value (as the scanner would find it). */
export function showsKnownValue(joined: JoinedText, knownValues: Iterable<string>): boolean {
  return knownValueUnits(joined, knownValues).includes(1)
}

/** A passage of `joined`: its units [begin, end). */
export interface Passage {
  begin: number
  end: number
}

/**
 * The places of `needle` in `joined` a reader could select: as written, or, when it's nowhere as
 * written, with spaces aside (the agent copies text from a snapshot whose lines are trimmed:
 * "Nadal 's" for the page's "Nadal's"). Whole characters at both ends, and none touching a known
 * secret value shown on the page: a part of one, guessed, is never told from a miss.
 */
export function passages(
  joined: JoinedText,
  needle: string,
  knownValues: Iterable<string> = [],
): Passage[] {
  const { text, starts } = joined
  const masked = knownValueUnits(joined, knownValues)
  const readable = ({ begin, end }: Passage) =>
    starts[begin] === true &&
    (end >= text.length || starts[end] === true) &&
    !masked.subarray(begin, end).includes(1)
  const exact = occurrences(text, needle)
    .map((at) => ({ begin: at, end: at + needle.length }))
    .filter(readable)
  if (exact.length > 0) return exact
  // Spaces aside: each unit of the text without them, traced to the text's own.
  const units: number[] = []
  let tight = ""
  for (let u = 0; u < text.length; u++) {
    if (text[u] === " ") continue
    tight += text[u]
    units.push(u)
  }
  const bare = needle.replace(/ /g, "")
  if (bare === "") return []
  return occurrences(tight, bare)
    .map((at) => ({ begin: units[at] ?? 0, end: (units[at + bare.length - 1] ?? 0) + 1 }))
    .filter(readable)
}
